"use strict";

const { execFileSync } = require("node:child_process");

const EXACT_COMMIT_RE = /^[0-9a-f]{40}$/;

function resolveExactCheckedOutHead(cwd = process.cwd(), exec = execFileSync) {
  let raw;
  try {
    raw = exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "git rev-parse failed").trim();
    throw new Error(`unable to determine exact checked-out source HEAD: ${detail}`);
  }

  const head = String(raw || "").trim().toLowerCase();
  if (!EXACT_COMMIT_RE.test(head)) {
    throw new Error(`unable to determine exact checked-out source HEAD: invalid git commit '${head || "<empty>"}'`);
  }
  return head;
}

module.exports = { EXACT_COMMIT_RE, resolveExactCheckedOutHead };
