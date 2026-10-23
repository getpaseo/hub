{
  description = "paseo-hub: self-hosted automation layer for Paseo daemons";

  inputs = {
    # Pin via flake.lock for reproducibility. nixos-unstable carries recent
    # nodejs_22 and the current buildNpmPackage/fetchNpmDeps machinery.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Systems paseo-hub is known to build for. The dependency tree is pure JS
      # (wasm pglite; prebuilt native TS/rollup binaries via optionalDeps), so
      # any nixpkgs-supported linux/darwin system works; keep the common ones.
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Source tree handed to the builder. Everything npm/tsgo/vite needs is
      # included; generated/VCS dirs are excluded so the fixed-output paths
      # stay stable and lean.
      src = builtins.path {
        name = "paseo-hub-source";
        path = ./.;
        filter = path: type:
          let base = baseNameOf path;
          in !(type == "directory" && (
            base == "node_modules" || base == ".git" || base == ".dev" ||
            base == "dist" || base == ".output" || base == ".typecheck" ||
            base == "base" || base == "e2e-report"
          ));
      };

      # `pg@8.20.0` declares an OPTIONAL dependency `pg-hubflare@1.3.0` that has
      # since been fully unpublished from the npm registry (packument 404s). A
      # real `npm ci` merely warns and omits it, which is why the repo's
      # Dockerfile still works, but nixpkgs' fetchNpmDeps downloads every
      # lockfile entry and fails hard on the dead tarball.
      #
      # Rather than mutate the committed package-lock.json, drop the dead
      # optional dep from a *build-only* copy of the lockfile. If pg-hubflare is
      # ever republished (or pg drops it), this step becomes a no-op and can be
      # deleted; it throws if the expected entries are no longer present so
      # staleness is loud rather than silent.
      mkCleanSrc = pkgs:
        let script = pkgs.writeText "strip-dead-optional.mjs" ''
          import { readFileSync, writeFileSync } from "node:fs";
          const p = process.argv[2];
          const lock = JSON.parse(readFileSync(p, "utf8"));
          let changed = false;
          // leaf entry (packages."node_modules/pg-hubflare")
          if (lock.packages?.["node_modules/pg-hubflare"]) {
            delete lock.packages["node_modules/pg-hubflare"];
            changed = true;
          }
          // reference from pg's optionalDependencies
          const pg = lock.packages?.["node_modules/pg"];
          if (pg?.optionalDependencies?.["pg-hubflare"]) {
            delete pg.optionalDependencies["pg-hubflare"];
            changed = true;
          }
          if (!changed) throw new Error("pg-hubflare not found; re-check whether it can be removed");
          writeFileSync(p, JSON.stringify(lock, null, 2) + "\n");
        '';
        in pkgs.runCommand "paseo-hub-clean-src" {
          nativeBuildInputs = [ pkgs.nodejs_22 ];
        } ''
          cp -r --no-preserve=mode,ownership ${src} $out
          chmod -R u+w $out
          node ${script} $out/package-lock.json
        '';

      # Build the Hub package against a specific pkgs instance (pinned nixpkgs
      # for `packages`, or the importing system's pkgs for the NixOS module).
      mkHub = pkgs:
        let
          nodejs = pkgs.nodejs_22; # parity with Dockerfile (node:22-slim)
          # Build against the sanitized lock (and feed the same tree to the
          # offline dependency fetcher) so the lockfile consistency check in
          # npmConfigHook passes.
          cleanSrc = mkCleanSrc pkgs;
        in pkgs.buildNpmPackage {
          pname = "paseo-hub";
          version = "0.9.0";

          inherit nodejs;
          src = cleanSrc;
          npmDeps = pkgs.fetchNpmDeps {
            src = cleanSrc;
            # Compute via `nix build .#paseo-hub`: it fails fast and prints
            # `got: sha256-...`; paste that value here.
            hash = "sha256-nxovNBTMSBSFD2wXSp/KrXTc6tkIoswyi5rCcJmnRbc=";
          };

          # Root npm "build" = tsgo (build:node -> dist/) then vite
          # (build:start -> .output/). Runs after `npm ci` from npmDeps.
          npmBuildScript = "build";

          nativeBuildInputs = [ pkgs.makeWrapper ];

          # Playwright browsers are only needed for e2e tests, never to build or
          # run the Hub; stop the package install from trying to fetch them.
          env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

          # Assemble a runtime layout mirroring the published npm package
          # (<pkg>/bin, dist, .output, drizzle + node_modules) so that
          # `node dist/index.js` finds its bundled assets via runtimeFile().
          # Ship our own `paseo-hub` launcher instead of npm bin shims.
          installPhase = ''
            runHook preInstall

            pkgDir="$out/lib/node_modules/paseo-hub"
            mkdir -p "$pkgDir" "$out/bin"

            cp -r node_modules "$pkgDir/node_modules"
            cp -r dist .output drizzle "$pkgDir/"
            cp package.json "$pkgDir/package.json"

            # Run dist/index.js from the package root so runtimeFile() (cwd
            # fallback) resolves .output and drizzle next to the binary, matching
            # `npm start` in the Docker image. Thread the system CA bundle so
            # outbound HTTPS (GitHub/Slack/Discord/Stripe/Resend) works on NixOS.
            makeWrapper "${nodejs}/bin/node" "$out/bin/paseo-hub" \
              --chdir "$pkgDir" \
              --add-flags "dist/index.js" \
              --prefix PATH : "${nodejs}/bin" \
              --set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
              --set-default NODE_EXTRA_CA_CERTS "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Self-hosted automation layer for Paseo daemons";
            homepage = "https://paseo.sh/docs/hub";
            license = licenses.asl20;
            platforms = platforms.linux ++ platforms.darwin;
            mainProgram = "paseo-hub";
          };
        };

      pkgFor = system:
        mkHub (import nixpkgs { inherit system; });

      # NixOS module: runs the Hub as a hardened systemd service under a
      # dedicated, unprivileged user, with state persisted under the data dir.
      #
      # Runtime contract this module encodes (from src/index.ts and
      # src/data-directory.ts):
      #   * PORT              - TCP listen port (default 3000)
      #   * PASEO_HUB_BIND    - listen address (default 0.0.0.0)
      #   * PASEO_HUB_APP_URL - canonical external origin the Hub advertises
      #   * PASEO_HUB_DATA_DIR- absolute dir for the embedded pglite DB. The
      #                         launcher chdir's into the (read-only) Nix store,
      #                         so this MUST be absolute and writable.
      #   * DATABASE_URL      - when set, uses Postgres instead of embedded DB
      #   * PASEO_HUB_TRUSTED_CLIENT_IP_HEADER - e.g. X-Forwarded-For behind a
      #                         reverse proxy
      #
      # Anything else (provider OAuth tokens, Stripe, mail, bootstrap policy,
      # auth secret) is passed verbatim via `environment` / `environmentFile`;
      # Hub never silently invents configuration, and neither does this module.
      nixosModule = { config, lib, pkgs, ... }:
        let
          cfg = config.services.paseo-hub;
          inherit (lib) mkEnableOption mkIf mkOption types optional optionalAttrs mapAttrsToList;
        in
        {
          options.services.paseo-hub = {
            enable = mkEnableOption "the Paseo Hub server";

            package = mkOption {
              type = types.package;
              description = "The paseo-hub package to run.";
              default = pkgFor pkgs.stdenv.hostPlatform.system;
              defaultText = "paseo-hub built from this flake for the host system";
            };

            port = mkOption {
              type = types.port;
              default = 3000;
              description = "TCP port the Hub listens on (PORT).";
            };

            address = mkOption {
              type = types.str;
              default = "0.0.0.0";
              description = "Address the Hub binds to (PASEO_HUB_BIND).";
            };

            appUrl = mkOption {
              type = types.nullOr types.str;
              default = null;
              description = ''
                Canonical external origin (PASEO_HUB_APP_URL), e.g.
                https://hub.example.com. Links, redirects, and provider
                webhooks use this. Defaults to Hub's own localhost origin.
              '';
            };

            dataDir = mkOption {
              type = types.nullOr types.path;
              default = "/var/lib/paseo-hub";
              description = ''
                Directory for the embedded pglite database (PASEO_HUB_DATA_DIR).
                Must be absolute; the module creates it owned by the service
                user. Ignored when databaseUrl is set.
              '';
            };

            databaseUrl = mkOption {
              type = types.nullOr types.str;
              default = null;
              description = ''
                When set, uses the given Postgres instead of the embedded
                database (DATABASE_URL), e.g.
                postgres://user:pass@localhost:5432/paseo_hub.
              '';
            };

            trustedClientIpHeader = mkOption {
              type = types.nullOr types.str;
              default = null;
              description = ''
                Request header carrying the real client IP (PASEO_HUB_TRUSTED_CLIENT_IP_HEADER),
                e.g. "X-Forwarded-For", when Hub runs behind a reverse proxy.
              '';
            };

            openFirewall = mkOption {
              type = types.bool;
              default = false;
              description = "Open cfg.port in the firewall.";
            };

            environment = mkOption {
              type = types.attrsOf types.str;
              default = { };
              description = ''
                Additional environment variables passed to the service verbatim.
                Use for provider/billing/mail configuration and the auth secret
                (see .env.example). Prefer environmentFile for secrets so they
                stay out of the Nix store.
              '';
            };

            environmentFile = mkOption {
              type = types.nullOr types.path;
              default = null;
              description = ''
                Optional systemd EnvironmentFile (KEY=VALUE lines) for secrets
                such as PASEO_HUB_AUTH_SECRET and provider tokens.
              '';
            };
          };

          config = mkIf cfg.enable {
            users.users.paseo-hub = {
              isSystemUser = true;
              group = "paseo-hub";
              description = "Paseo Hub service user";
            };
            users.groups.paseo-hub = { };

            # Create and own the data dir even across reboots / package swaps.
            systemd.tmpfiles.rules = [
              "d '${cfg.dataDir}' 0700 paseo-hub paseo-hub -"
            ];

            networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];

            systemd.services.paseo-hub = {
              description = "Paseo Hub";
              wantedBy = [ "multi-user.target" ];
              wants = [ "network-online.target" ];
              after = [ "network-online.target" ];

              serviceConfig = {
                Type = "simple";
                User = "paseo-hub";
                Group = "paseo-hub";
                ExecStart = "${cfg.package}/bin/paseo-hub";
                Restart = "on-failure";
                RestartSec = "5s";

                # Env from Hub's runtime contract plus the user's passthrough.
                Environment = ([
                  "PORT=${toString cfg.port}"
                  "PASEO_HUB_BIND=${cfg.address}"
                ]
                  ++ optional (cfg.appUrl != null) "PASEO_HUB_APP_URL=${cfg.appUrl}"
                  ++ optional (cfg.dataDir != null) "PASEO_HUB_DATA_DIR=${cfg.dataDir}"
                  ++ optional (cfg.databaseUrl != null) "DATABASE_URL=${cfg.databaseUrl}"
                  ++ optional (cfg.trustedClientIpHeader != null)
                    "PASEO_HUB_TRUSTED_CLIENT_IP_HEADER=${cfg.trustedClientIpHeader}"
                  ++ mapAttrsToList (name: value: "${name}=\"${value}\"") cfg.environment);

                # Systemd hardening. state/data writes are confined to dataDir
                # (ReadWritePaths) and the private /tmp (PrivateTmp).
                NoNewPrivileges = true;
                PrivateTmp = true;
                PrivateDevices = true;
                ProtectSystem = "strict";
                ProtectHome = true;
                ProtectKernelTunables = true;
                ProtectKernelModules = true;
                ProtectControlGroups = true;
                RestrictSUIDSGID = true;
                LockPersonality = true;
              } // optionalAttrs (cfg.dataDir != null) {
                ReadWritePaths = [ cfg.dataDir ];
              } // optionalAttrs (cfg.environmentFile != null) {
                EnvironmentFile = cfg.environmentFile;
              };
            };
          };
        };
    in
    {
      packages = forAllSystems (system: {
        paseo-hub = pkgFor system;
        default = pkgFor system;
      });

      nixosModules = {
        default = nixosModule;
        paseo-hub = nixosModule;
      };
    };
}
