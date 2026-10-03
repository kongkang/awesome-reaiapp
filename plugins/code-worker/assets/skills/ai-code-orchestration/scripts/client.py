#!/usr/bin/env python3
"""Same-device orchestration client. Credentials stay in private files, not argv."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import urllib.error
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("Gateway redirects are not allowed")


def private_write(path, value):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(value, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())


class Client:
    def __init__(self, path):
        self.path = Path(path).resolve()
        if os.name == "posix" and self.path.stat().st_mode & 0o077:
            raise RuntimeError("Connection file must be private (chmod 600)")
        self.connection = json.loads(self.path.read_text())
        endpoint = self.connection.get("endpoint", "")
        match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})/v1/call", endpoint)
        if not match or not 0 < int(match[1]) < 65536 or not re.fullmatch(r"[0-9a-f]{64}", self.connection.get("token", "")):
            raise RuntimeError("Invalid same-device connection")
        self.pending = self.path.with_name(self.path.name + ".pending.json")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, value):
        body = json.dumps({"method": "invoke", "input": value}).encode()
        request = urllib.request.Request(self.connection["endpoint"], data=body,
            headers={"Authorization": "Bearer " + self.connection["token"], "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=20) as response:
                result = json.loads(response.read(256 * 1024 + 1))
        except urllib.error.HTTPError as error:
            # No retry on error; leave the exact write envelope for explicit reconciliation.
            try:
                detail = json.loads(error.read(4096)).get("error", {}).get("code", "HTTP_ERROR")
            except (ValueError, AttributeError):
                detail = "HTTP_ERROR"
            raise RuntimeError("Gateway rejected request: " + str(detail)) from None
        if "result" not in result:
            raise RuntimeError("Invalid gateway response")
        return result["result"]

    def read(self):
        return self.call({"kind": "read"})

    def act(self, operation, payload):
        if self.pending.exists():
            raise RuntimeError("An earlier write is unresolved; use replay/read before another action")
        state = self.read()
        action = {"requestId": str(uuid.uuid4()), "expectedRevision": state["revision"], "operation": operation, "payload": payload}
        private_write(self.pending, action)
        return self.replay()

    def replay(self):
        action = json.loads(self.pending.read_text())
        result = self.call({"kind": "act", "action": action})
        self.pending.unlink()
        return result

    def resolve(self, record_path):
        """Explicit reconciliation only: archive the decision, never silently discard a write."""
        action = json.loads(self.pending.read_text())
        decision = json.loads(Path(record_path).read_text())
        if decision.get("requestId") != action["requestId"] or decision.get("outcome") not in ("applied", "not-applied") or not str(decision.get("evidence", "")).strip():
            raise RuntimeError("Reconciliation requires the original requestId, outcome and observed evidence")
        current = self.read()
        if decision.get("observedRevision") != current["revision"]:
            raise RuntimeError("State changed; reconcile against the current revision")
        path = self.pending.with_name(self.pending.name + ".resolved-" + str(uuid.uuid4()) + ".json")
        private_write(path, {"action": action, "decision": decision})
        self.pending.unlink()
        return {"reconciliationFile": str(path), "outcome": decision["outcome"]}

    def public_result(self, result):
        if isinstance(result, dict) and isinstance(result.get("connection"), dict):
            connection = result["connection"]
            path = self.path.parent / ("agent-" + str(uuid.uuid4()) + ".json")
            private_write(path, connection)
            result = dict(result, connection={"connectionFile": str(path), "id": connection.get("id")})
        return result

    def run(self, command, report_path):
        if not command:
            raise RuntimeError("An authorized Agent command is required")
        report_path = Path(report_path)
        if report_path.exists():
            raise RuntimeError("Use a new report path; old results cannot complete a new attempt")
        state = self.read()
        role = state["identity"]["role"]
        if role not in ("worker", "tester") or len(state["children"]) != 1:
            raise RuntimeError("This connection is not an assigned Worker/Tester")
        child = state["children"][0]["id"]
        self.act("begin", {"childId": child})
        process = None
        try:
            process = subprocess.Popen(command, start_new_session=(os.name == "posix"))
            status = process.wait()
            if status:
                raise RuntimeError("Agent exited with status " + str(status))
            if os.name == "posix":
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    pass
                else:
                    raise RuntimeError("Agent left background processes running; foreground execution is required")
            report = json.loads(report_path.read_text())
            if role == "worker":
                return self.act("work", {"childId": child, "result": json.dumps(report["result"], ensure_ascii=False)})
            return self.act("test", {"childId": child, "verdict": report["verdict"], "evidence": json.dumps(report["evidence"], ensure_ascii=False)})
        except BaseException:
            if process is not None:
                if os.name == "posix":
                    # Stop only this runner's isolated process group, including foreground descendants.
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(process.pid, sig)
                        except ProcessLookupError:
                            break
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            pass
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        pass
                    else:
                        raise RuntimeError("Process group exit is unconfirmed; keep quota and ask the orchestrator to reconcile") from None
                elif process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            # A lost completion response must be replayed, not overwritten with cancellation.
            if not self.pending.exists():
                try:
                    self.act("cancel", {"childId": child, "reason": "Runner confirmed Agent process stopped without a completed report"})
                except Exception:
                    pass  # Exact pending request remains available for reconciliation.
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("read")
    sub.add_parser("skill")
    sub.add_parser("replay")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--record", required=True)
    action = sub.add_parser("act")
    action.add_argument("operation")
    action.add_argument("--payload", required=True)
    run = sub.add_parser("run")
    run.add_argument("--report", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    client = Client(args.connection)
    if args.action == "read":
        result = client.read()
    elif args.action == "skill":
        result = client.call({"kind": "skill"})
    elif args.action == "replay":
        result = client.replay()
    elif args.action == "resolve":
        result = client.resolve(args.record)
    elif args.action == "act":
        result = client.act(args.operation, json.loads(Path(args.payload).read_text()))
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        result = client.run(command, args.report)
    print(json.dumps(client.public_result(result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
