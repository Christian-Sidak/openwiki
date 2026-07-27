"""Harbor Codex adapters for paired DeepSWE/OpenWiki evaluations."""

from __future__ import annotations

import json
import re
import shlex
import time
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor_langsmith import parent_env


_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$")
_GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_APP_DIR = PurePosixPath("/app")
_OPENWIKI_SOURCE_DIR = PurePosixPath("/tmp/openwiki-source")
_OPENWIKI_HOME_DIR = PurePosixPath("/tmp/openwiki-home")
_REMOTE_PACKAGE_PATH = PurePosixPath("/tmp/openwiki-eval.tgz")
_OPENWIKI_LOG_PATH = PurePosixPath("/logs/agent/openwiki.log")


class BaselineCodex(Codex):
    """Codex with credential-safe Harbor command logging for the control arm."""

    @staticmethod
    def name() -> str:
        return "codex-baseline"

    async def install(self, environment: BaseEnvironment) -> None:
        """Install pinned Codex without Harbor's unnecessary NVM bootstrap."""

        if await self._installed_codex_satisfies_version(environment):
            return
        if self._version is None or not re.fullmatch(r"\d+\.\d+\.\d+", self._version):
            raise ValueError("a pinned semantic Codex version is required")
        await self.exec_as_root(
            environment,
            command=(
                "if command -v rg >/dev/null 2>&1; then :; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache ripgrep; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y ripgrep; "
                "elif command -v yum >/dev/null 2>&1; then "
                "yum install -y ripgrep; "
                "else echo 'No supported package manager for ripgrep' >&2; exit 1; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        package = shlex.quote(f"@openai/codex@{self._version}")
        await self.exec_as_agent(
            environment,
            command=(
                f"npm install -g {package} --ignore-scripts --no-audit --no-fund && "
                "codex --version"
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run Codex and capture committed work for DeepSWE's verifier.

        DeepSWE v1.1 normally relies on Pier's ``pre_artifacts.sh`` lifecycle.
        Harbor 0.20 does not execute that hook, so the adapter performs the same
        base-to-final-HEAD patch capture after the agent exits.
        """

        head_result = await self.exec_as_agent(
            environment,
            command="git rev-parse HEAD",
            cwd=_APP_DIR.as_posix(),
        )
        start_head = (head_result.stdout or "").strip()
        if not _GIT_COMMIT_RE.fullmatch(start_head):
            raise RuntimeError("Task repository returned an invalid starting commit")
        await self.exec_as_agent(
            environment,
            command=(
                "git config user.name 'DeepSWE Eval' && "
                "git config user.email 'deepswe-eval@local.invalid'"
            ),
            cwd=_APP_DIR.as_posix(),
        )
        try:
            await super().run(instruction, environment, context)
        finally:
            patch_path = PurePosixPath("/logs/artifacts/model.patch")
            await self.exec_as_agent(
                environment,
                command=(
                    "umask 077; mkdir -p /logs/artifacts && "
                    f"git diff --binary {shlex.quote(start_head)} HEAD > "
                    f"{shlex.quote(patch_path.as_posix())} && "
                    f"chmod 0600 {shlex.quote(patch_path.as_posix())}"
                ),
                cwd=_APP_DIR.as_posix(),
            )

    async def _exec(
        self,
        environment: BaseEnvironment,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        """Execute without logging environment values or command output.

        Harbor's upstream helper includes the per-command environment in debug log
        metadata. Eval jobs necessarily pass provider credentials, so this
        adapter deliberately keeps environment values out of logs.
        """

        result = await environment.exec(
            command=f"set -o pipefail; {command}",
            user=user,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Sandbox command failed with exit code {result.return_code}; "
                "inspect the trial logs for non-sensitive diagnostics."
            )
        return result


class OpenWikiCodex(BaselineCodex):
    """Generate OpenWiki in an isolated clone before running the same Codex agent."""

    def __init__(
        self,
        *args: Any,
        openwiki_package: str,
        openwiki_model: str,
        openwiki_timeout_sec: int = 5400,
        retrieval_embedding_provider: str = "local",
        **kwargs: Any,
    ) -> None:
        package_path = Path(openwiki_package).expanduser().resolve()
        if package_path.suffix != ".tgz" or not package_path.is_file():
            raise ValueError("openwiki_package must be an existing .tgz file")
        if not _MODEL_ID_RE.fullmatch(openwiki_model):
            raise ValueError("openwiki_model contains unsupported characters")
        if openwiki_timeout_sec <= 0 or openwiki_timeout_sec > 14_400:
            raise ValueError("openwiki_timeout_sec must be between 1 and 14400")
        if retrieval_embedding_provider not in {"local", "openai"}:
            raise ValueError("retrieval_embedding_provider must be local or openai")

        self._openwiki_package = package_path
        self._openwiki_model = openwiki_model
        self._openwiki_timeout_sec = openwiki_timeout_sec
        self._retrieval_embedding_provider = retrieval_embedding_provider
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "codex-openwiki"

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.upload_file(
            self._openwiki_package, _REMOTE_PACKAGE_PATH.as_posix()
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 0644 {shlex.quote(_REMOTE_PACKAGE_PATH.as_posix())}",
        )
        await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                f"npm install -g {shlex.quote(_REMOTE_PACKAGE_PATH.as_posix())} "
                "--ignore-scripts --no-audit --no-fund && "
                'cd "$(npm root -g)/openwiki" && '
                "npm rebuild better-sqlite3 --foreground-scripts "
                "--no-audit --no-fund && "
                "node -e \"require('better-sqlite3')\" && "
                "command -v openwiki >/dev/null"
            ),
        )
        openwiki_bin_result = await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; command -v openwiki"
            ),
        )
        openwiki_bin_lines = [
            line.strip()
            for line in (openwiki_bin_result.stdout or "").splitlines()
            if line.strip()
        ]
        openwiki_bin = openwiki_bin_lines[-1] if openwiki_bin_lines else ""
        if not re.fullmatch(r"/[A-Za-z0-9._/@+-]+", openwiki_bin):
            raise RuntimeError("OpenWiki installation returned an invalid binary path")
        await self.exec_as_root(
            environment,
            command=(f"ln -sf {shlex.quote(openwiki_bin)} /usr/local/bin/openwiki"),
        )
        retrieval_bin_result = await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                "command -v openwiki-retrieval-mcp"
            ),
        )
        retrieval_bin_lines = [
            line.strip()
            for line in (retrieval_bin_result.stdout or "").splitlines()
            if line.strip()
        ]
        retrieval_bin = retrieval_bin_lines[-1] if retrieval_bin_lines else ""
        if not re.fullmatch(r"/[A-Za-z0-9._/@+-]+", retrieval_bin):
            raise RuntimeError("OpenWiki retrieval installation returned an invalid path")
        await self.exec_as_root(
            environment,
            command=(
                f"ln -sf {shlex.quote(retrieval_bin)} "
                "/usr/local/bin/openwiki-retrieval-mcp"
            ),
        )

    def _build_register_mcp_servers_command(self) -> str:
        """Register the fixed read-only OpenWiki retrieval server for Codex."""

        provider = shlex.quote(self._retrieval_embedding_provider)
        return (
            "codex mcp add openwiki_retrieval -- "
            "/usr/local/bin/openwiki-retrieval-mcp "
            f"--repo-root {_APP_DIR.as_posix()} "
            f"--wiki-root {(_OPENWIKI_SOURCE_DIR / 'openwiki').as_posix()} "
            f"--embedding-provider {provider}"
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        started = time.monotonic()
        status = "failure"
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"mkdir -p {shlex.quote(_OPENWIKI_HOME_DIR.as_posix())} && "
                    f"git clone --quiet --no-hardlinks "
                    f"{shlex.quote(_APP_DIR.as_posix())} "
                    f"{shlex.quote(_OPENWIKI_SOURCE_DIR.as_posix())}"
                ),
                timeout_sec=600,
            )

            trace_env = parent_env(self.context_id)
            wiki_env = {
                "HOME": _OPENWIKI_HOME_DIR.as_posix(),
                "OPENAI_API_KEY": self._get_env("OPENAI_API_KEY") or "",
                "LANGSMITH_API_KEY": self._get_env("LANGSMITH_API_KEY") or "",
                "LANGCHAIN_TRACING_V2": "true",
                "OPENWIKI_PROVIDER": "openai",
                "OPENWIKI_MODEL_ID": self._openwiki_model,
                "OPENWIKI_TELEMETRY_DISABLED": "1",
                "DO_NOT_TRACK": "1",
                **trace_env,
            }
            if project := trace_env.get("LANGSMITH_PROJECT"):
                # OpenWiki currently uses the LangChain v2 tracing variable.
                wiki_env["LANGCHAIN_PROJECT"] = project
            for key in ("LANGSMITH_ENDPOINT", "LANGSMITH_WORKSPACE_ID"):
                if value := self._get_env(key):
                    wiki_env[key] = value
            if openai_base_url := self._get_env("OPENAI_BASE_URL"):
                wiki_env["OPENAI_BASE_URL"] = openai_base_url
            await self.exec_as_agent(
                environment,
                command=(
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                    "openwiki code --init --print "
                    f"> {shlex.quote(_OPENWIKI_LOG_PATH.as_posix())} 2>&1"
                ),
                env=wiki_env,
                cwd=_OPENWIKI_SOURCE_DIR.as_posix(),
                timeout_sec=self._openwiki_timeout_sec,
            )
            status = "success"
        finally:
            elapsed = round(time.monotonic() - started, 3)
            openwiki_metadata = {
                "status": status,
                "duration_seconds": elapsed,
                "model": self._openwiki_model,
                "quickstart": (
                    _OPENWIKI_SOURCE_DIR / "openwiki" / "quickstart.md"
                ).as_posix(),
            }
            context.metadata = {
                **(context.metadata or {}),
                "openwiki": openwiki_metadata,
            }
            (self.logs_dir / "openwiki.json").write_text(
                json.dumps(openwiki_metadata, indent=2) + "\n",
                encoding="utf-8",
            )

        quickstart_path = (
            _OPENWIKI_SOURCE_DIR / "openwiki" / "quickstart.md"
        ).as_posix()
        treatment_instruction = (
            "OpenWiki treatment condition: use the generated wiki and the read-only "
            "openwiki_retrieval MCP tools as a just-in-time repository index. At task "
            "start, call change_surface with the requested change, then "
            f"read {quickstart_path}, search the wiki for the task concepts, and read "
            "only the relevant linked pages. Before a repository-wide rg, find, or "
            "exploratory directory scan, check the wiki source maps and inspect named "
            "files, symbols, and tests directly. Re-consult the wiki when entering a "
            "different subsystem, when source contradicts the current understanding, "
            "or when blocked by an unfamiliar test or build failure. Do not read "
            "operations, release, or integration pages unless the task affects them, "
            "and do not reread pages without new evidence. Before finishing a public "
            "API or cross-package change, trace the change from its implementation "
            "through internal and package exports, generated or publish mirrors, "
            "initialization or registration, and the import path real consumers use. "
            "Consult the wiki's relevant integration or delivery guidance and run the "
            "narrowest consumer-facing check; passing only internal unit tests does not "
            "prove the shipped surface works. If the repository generates or copies "
            "package artifacts, follow its documented synchronization workflow rather "
            "than assuming the defining source module is sufficient. "
            "For stateful or lifecycle behavior, turn every externally observable "
            "acceptance criterion into a test checklist before editing. Where relevant, "
            "cover initial state, false-to-true and true-to-false transitions, unchanged "
            "updates, missing dependencies, independent instances, reset or reuse, "
            "deferred or re-entrant mutation, and composition with adjacent features. "
            "When behavior is unfamiliar, the relevant tests are large, or no analogous "
            "focused check is known, use test_search with that behavior matrix and "
            "inspect the cited tests directly. "
            "Before committing, map each criterion to a passing focused test; one happy "
            "path does not establish transition or isolation correctness. "
            "Use hybrid_search for broad ranked discovery, okf_graph_search to follow "
            "related concepts and cross-package relationships, semantic_search when "
            "the repository uses unfamiliar vocabulary, BM25 for precise concepts, "
            "test_search when analogous behavioral checks are needed, and keyword_search "
            "for exact symbols. Verify all retrieval excerpts in "
            "source before editing. After adding or changing a public symbol, call "
            "symbol_trace for that exact identifier; investigate missing export, "
            "publish, consumer, initialization, or test groups when the repository's "
            "architecture requires them. Call change_surface again before finalizing "
            "if the patch added a public API, generated artifact, or registration path. "
            "The wiki is a navigation aid generated from the same base checkout. "
            "Treat /app as the source of truth, make all code changes only in /app, "
            "and do not edit /tmp/openwiki-source.\n\n"
            f"{instruction}"
        )
        await super().run(treatment_instruction, environment, context)
