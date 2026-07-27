from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from requests import HTTPError, Response

import deepswe_langsmith
import run as deepswe_run


class DeepSWEHarnessTests(unittest.TestCase):
    def test_langsmith_feedback_rounds_scores_and_skips_invalid_metrics(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        plugin._post_feedback = Mock()
        result = SimpleNamespace(
            verifier_result=SimpleNamespace(
                rewards={
                    "reward": 0,
                    "partial": 0.35877862595419846,
                    "count": 47,
                    "not_a_number": float("nan"),
                    "boolean": True,
                }
            ),
            exception_info=None,
        )

        plugin._create_feedback("00000000-0000-0000-0000-000000000001", result)

        payloads = [call.args[0] for call in plugin._post_feedback.call_args_list]
        self.assertEqual(["reward", "partial"], [payload["key"] for payload in payloads])
        self.assertEqual([0.0, 0.3588], [payload["score"] for payload in payloads])

    def test_langsmith_feedback_http_error_does_not_abort_trial(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        response = Response()
        response.status_code = 422
        response.headers["x-request-id"] = "safe-request-id"
        plugin._request = Mock(side_effect=HTTPError(response=response))

        with self.assertWarnsRegex(
            RuntimeWarning, "status=422, request_id=safe-request-id"
        ):
            plugin._post_feedback({"score": 0})

    def test_langsmith_feedback_programming_error_still_propagates(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        plugin._request = Mock(side_effect=TypeError("invalid payload"))

        with self.assertRaisesRegex(TypeError, "invalid payload"):
            plugin._post_feedback({"score": 0})

    def test_openwiki_install_rebuilds_only_native_sqlite_dependency(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("npm install -g", adapter)
        self.assertIn("--ignore-scripts", adapter)
        self.assertIn("npm rebuild better-sqlite3", adapter)
        self.assertIn("require('better-sqlite3')", adapter)

    def test_adapter_captures_committed_patch_for_separate_verifier(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("_GIT_COMMIT_RE.fullmatch(start_head)", adapter)
        self.assertIn("git config user.name 'DeepSWE Eval'", adapter)
        self.assertIn("git diff --binary", adapter)
        self.assertIn("/logs/artifacts/model.patch", adapter)
        self.assertIn("chmod 0600", adapter)

    def test_openwiki_treatment_uses_just_in_time_navigation(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("just-in-time", adapter)
        self.assertIn("Before a repository-wide rg", adapter)
        self.assertIn("only the relevant linked pages", adapter)
        self.assertIn("Re-consult the wiki", adapter)
        self.assertIn("import path real consumers use", adapter)
        self.assertIn("passing only internal unit tests", adapter)
        self.assertIn("codex mcp add openwiki_retrieval", adapter)
        self.assertIn("call change_surface", adapter)
        self.assertIn("symbol_trace", adapter)
        self.assertIn("okf_graph_search", adapter)
        self.assertIn("every externally observable", adapter)
        self.assertIn("independent instances", adapter)
        self.assertIn("use test_search", adapter)

    def test_eval_defaults_use_terra_without_changing_openwiki_defaults(self) -> None:
        args = deepswe_run.parse_args(["paired"])
        self.assertEqual("openai/gpt-5.6-terra", args.model)
        self.assertEqual("gpt-5.6-terra", args.openwiki_model)

    def test_paired_commands_share_selection_and_agent_settings(self) -> None:
        args = deepswe_run.parse_args(
            [
                "paired",
                "--n-tasks",
                "7",
                "--seed",
                "42",
                "--task",
                "happy-dom-*",
                "--dry-run",
            ]
        )
        package = args.artifacts_dir / "openwiki-eval.tgz"
        baseline = deepswe_run.harbor_args(args, condition="baseline")
        treatment = deepswe_run.harbor_args(
            args, condition="openwiki", package_path=package
        )

        for flag in (
            "--path",
            "--model",
            "--env",
            "--n-attempts",
            "--n-concurrent",
            "--n-tasks",
            "--include-task-name",
        ):
            self.assertEqual(
                baseline[baseline.index(flag) + 1], treatment[treatment.index(flag) + 1]
            )
        self.assertIn("openwiki_codex:BaselineCodex", baseline)
        self.assertIn("openwiki_codex:OpenWikiCodex", treatment)
        self.assertEqual(2, baseline.count("--agent-kwarg"))
        self.assertEqual(6, treatment.count("--agent-kwarg"))
        self.assertIn("retrieval_embedding_provider=local", treatment)
        self.assertIn(f"version={deepswe_run.CODEX_VERSION}", baseline)
        self.assertIn("gateway.smith.langchain.com", baseline)
        self.assertIn("api.smith.langchain.com", baseline)
        self.assertEqual(1, baseline.count("--plugin"))
        self.assertEqual(
            "deepswe_langsmith:DeepSWELangSmithPlugin",
            baseline[baseline.index("--plugin") + 1],
        )
        self.assertNotEqual(
            baseline[baseline.index("--job-name") + 1],
            treatment[treatment.index("--job-name") + 1],
        )

        baseline_env = deepswe_run.langsmith_env(args)
        treatment_env = deepswe_run.langsmith_env(args)
        self.assertEqual(
            baseline_env["HARBOR_LANGSMITH_DATASET"],
            treatment_env["HARBOR_LANGSMITH_DATASET"],
        )
        self.assertEqual("true", baseline_env["HARBOR_LANGSMITH_SYNC_DATASET"])
        self.assertEqual("true", baseline_env["HARBOR_LANGSMITH_FAIL_FAST"])

        for host in deepswe_run.DEFAULT_ALLOWED_HOSTS:
            self.assertIn(host, baseline)
            self.assertIn(host, treatment)

    def test_custom_allowed_host_is_validated_and_included(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--allow-host", "Gateway.Example.com"]
        )
        command = deepswe_run.harbor_args(args, condition="baseline")
        self.assertIn("gateway.example.com", command)

        invalid = deepswe_run.parse_args(
            ["baseline", "--allow-host", "https://gateway.example.com/v1"]
        )
        with self.assertRaisesRegex(ValueError, "plain DNS hostname"):
            deepswe_run.harbor_args(invalid, condition="baseline")

    def test_display_command_redacts_agent_env(self) -> None:
        rendered = deepswe_run.display_command(
            ["harbor", "run", "--agent-env", "API_TOKEN=example-sensitive-value"]
        )
        self.assertNotIn("example-sensitive-value", rendered)
        self.assertIn("<redacted>", rendered)

    def test_credentials_require_openai_and_langsmith(self) -> None:
        args = deepswe_run.parse_args(["baseline"])
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "OPENAI_API_KEY"):
                deepswe_run.ensure_credentials(args)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "present"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "LANGSMITH_API_KEY"):
                deepswe_run.ensure_credentials(args)
        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "present", "LANGSMITH_API_KEY": "present"},
            clear=True,
        ):
            deepswe_run.ensure_credentials(args)

    def test_langsmith_endpoint_rejects_embedded_credentials(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--langsmith-endpoint", "https://user:secret@example.com"]
        )
        with self.assertRaisesRegex(ValueError, "without credentials"):
            deepswe_run.langsmith_env(args)

    def test_run_clears_ambient_experiment_overrides(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    "HARBOR_LANGSMITH_EXPERIMENT": "ambient",
                    "HARBOR_LANGSMITH_EXPERIMENT_ID": "ambient-id",
                },
            ),
            patch.object(deepswe_run.subprocess, "run") as run,
        ):
            deepswe_run.run_checked(
                ["harbor", "run"],
                env_unset=deepswe_run.LANGSMITH_ENV_UNSET,
            )
        child_env = run.call_args.kwargs["env"]
        self.assertNotIn("HARBOR_LANGSMITH_EXPERIMENT", child_env)
        self.assertNotIn("HARBOR_LANGSMITH_EXPERIMENT_ID", child_env)

    def test_seeded_task_selection_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for name in ("alpha", "beta", "gamma"):
                task_dir = root / "tasks" / name
                task_dir.mkdir(parents=True)
                (task_dir / "task.toml").write_text(
                    f'[task]\nname = "datacurve/{name}"\n', encoding="utf-8"
                )
            args = deepswe_run.parse_args(
                [
                    "paired",
                    "--deepswe-dir",
                    str(root),
                    "--n-tasks",
                    "2",
                    "--seed",
                    "42",
                ]
            )
            first = deepswe_run.select_tasks(args)
            second = deepswe_run.select_tasks(args)
            self.assertEqual(first, second)
            self.assertEqual(2, len(first or []))
            self.assertTrue(all("/" not in task_id for task_id in first or []))

    def test_load_and_aggregate_trial_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            trial_dir = job_dir / "trial-1"
            trial_dir.mkdir()
            (trial_dir / "result.json").write_text(
                json.dumps(
                    {
                        "task_name": "example-task",
                        "trial_name": "example-task__attempt-1",
                        "started_at": "2026-07-21T10:00:00+00:00",
                        "finished_at": "2026-07-21T10:02:00+00:00",
                        "agent_execution": {
                            "started_at": "2026-07-21T10:00:30+00:00",
                            "finished_at": "2026-07-21T10:01:30+00:00",
                        },
                        "n_agent_steps": 12,
                        "agent_result": {
                            "n_input_tokens": 100,
                            "n_cache_tokens": 40,
                            "n_output_tokens": 25,
                            "cost_usd": 0.5,
                            "metadata": {"openwiki": {"duration_seconds": 20.0}},
                        },
                        "verifier_result": {"rewards": {"reward": 1}},
                    }
                ),
                encoding="utf-8",
            )

            rows = deepswe_run.load_trial_rows(job_dir, "openwiki")
            self.assertEqual(1, len(rows))
            self.assertEqual(120.0, rows[0]["total_duration_seconds"])
            self.assertEqual(60.0, rows[0]["agent_duration_seconds"])
            self.assertEqual(20.0, rows[0]["openwiki_duration_seconds"])
            self.assertEqual(1.0, deepswe_run.aggregate(rows)["solve_rate"])


if __name__ == "__main__":
    unittest.main()
