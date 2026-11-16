# Code Mode for DeepSeek Harness

`run_code({ code })` runs a JavaScript program that calls DSH tools. Only the program's result and
its `self.log` output return to the model; intermediate tool output stays inside the program. Every
call a program makes still goes through `tools/pre-execute`, guards, approvals, and
`tools/post-execute`.

- Loading the bundle disables `tool-executor-native` and `tool-executor-ptc`: one tool executor owns
  the scope, so tools become callable only from inside a program.
- Programs run in a sealed QuickJS sandbox per agent. Top-level declarations persist across
  `run_code` calls of the same agent; a dead loop blocks the host until the run deadline.
- Limits (timeout, memory, sub-call counts, output caps) can be set in the profile's
  `cordis.patch.yml` under `config`; omitted fields keep their defaults.

Full documentation, limits, and the differences from DSH's built-in PTC executor:
<https://github.com/zhangliang0115/agent-plugin/tree/main/plugins/code-mode>.
