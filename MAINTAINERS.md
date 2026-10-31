# Maintaining Paseo Hub

This guide covers repository operations for maintainers. Product usage belongs in the
[public Hub documentation](https://paseo.sh/docs/hub); architecture decisions live under
[`docs/`](docs/).

## Verify a change

The required checks match the jobs in [CI](.github/workflows/ci.yml):

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run db:check
npm run build
npm run docker:smoke
npm run test:e2e:browser
npm run test:e2e:hub:source
```

The source-built browser and Hub suites use the exact Paseo commit in `PASEO_E2E_COMMIT`.
When a Hub change depends on a Paseo protocol or CLI change, update that immutable SHA and
prove the combined contract before merging. Do not replace it with a branch or another mutable
reference.

Use the repository formatter through `npm run format` or `npm run format:files`. This repository
uses Oxfmt, not Prettier.

## Publish a release

A Hub release is three artifacts: the `@getpaseo/hub` npm package, a multi-architecture
container image, and a GitHub Release. npm is published locally; the tag publishes the other two.
A release is not done until all three are out.

1. Update the version in `package.json` and `package-lock.json`.
2. Add a matching `## <version> - YYYY-MM-DD` section to `CHANGELOG.md`. The changelog describes
   the self-hosted release, so leave out changes that only affect the hosted service: plans,
   pricing, trials, billing, and hosted usage limits.
3. Run the release checks. `release:check` verifies release metadata, types, lint, formatting, the
   production build, and the npm package contents.

   ```sh
   npm run release:check
   ```

4. Commit the release preparation to `main` and push it.
5. Publish npm from that clean `main` checkout, then verify the public package from a directory
   outside the repository. Open the URL Hub prints, and stop it with Ctrl+C once the first-run
   page loads.

   ```sh
   npm whoami
   npm publish --access public
   npm view @getpaseo/hub version
   cd "$(mktemp -d)" && npx @getpaseo/hub@<version>
   ```

6. Create an annotated tag on the release commit and push it:

   ```sh
   git tag -a v<version> <commit> -m "Paseo Hub v<version>"
   git push origin v<version>
   ```

The tag must match both `package.json` and the changelog section. A tag push runs only the
[Release](.github/workflows/release.yml) workflow; it does not rerun the main CI suite. The
workflow publishes `ghcr.io/getpaseo/hub:<version>`, updates `latest` for stable releases, and
creates or updates the GitHub Release from the matching changelog section. Prereleases do not
move `latest`.

Before announcing the release, verify the GitHub Release, anonymous access to both image tags, and
that `npm view @getpaseo/hub dist-tags` shows the new version as `latest`. Later changes to the
current changelog section update the existing release notes through
[Release Notes Sync](.github/workflows/release-notes-sync.yml).

## Update public documentation

Public Hub documentation lives in `getpaseo/paseo` under `public-docs/`. Open a companion PR
when an API, interface, or user-facing workflow change affects what users need to know or do.
Internal changes and fixes that restore expected behavior do not require new public docs.
If existing documentation becomes inaccurate, correct it with the smallest necessary edit.

Document the intended public experience, not internal architecture or maintainer process.
Keep each addition tied to a reader’s task; omit details that do not help them complete it.
