import readline from "node:readline";

const provider = process.argv[2];
const args = process.argv.slice(3);

if (args.includes("--version")) {
  process.stdout.write(provider === "claude" ? "2.1.0 (Claude Code)\n" : "codex-cli 0.105.0\n");
  process.exit(0);
}

if (provider !== "codex" || !args.includes("app-server")) {
  throw new Error(
    `unsupported provider catalog shim invocation: ${process.argv.slice(2).join(" ")}`,
  );
}

const models = {
  data: [
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      description: "Hub source E2E catalog model",
      isDefault: true,
      model: "gpt-5.5",
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
    },
  ],
};
const savedConfig = {
  config: {
    model: "gpt-5.5",
    modelReasoningEffort: "xhigh",
    model_reasoning_effort: "xhigh",
  },
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (typeof request.id !== "number") return;
  const result =
    request.method === "model/list"
      ? models
      : request.method === "getUserSavedConfig" || request.method === "config/read"
        ? savedConfig
        : {};
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
