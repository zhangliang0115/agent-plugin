# Code Mode for DeepSeek Harness

`run_code({ code })` runs a JavaScript program that calls DSH tools. Only the program's result and
its `self.log` output return to the model; intermediate tool output stays inside the program. Every
call a program makes still goes through `tools/pre-execute`, guards, approvals, and
`tools/post-execute`.

- Loading the bundle declares a `code-mode` agent preset. The preset's row mounts this plugin, so
  its executor registers in that preset's agent scope. The deployment-level `tool-executor-native`
  and `tool-executor-ptc` stay enabled: DSH keeps one executor per scope, so the shipped presets
  (`standard`, `ptc`, `minimal`, `cordis`) and this one are all selectable.
- Profiles without an agent-preset registry (the `headless` template) cannot host a preset. There,
  apply `cordis.headless.patch.yml` as an overlay: it disables both deployment executors and mounts
  the plugin at the deployment scope, which replaces them for the whole profile.
- Programs run in a sealed QuickJS sandbox per agent. Top-level declarations persist across
  `run_code` calls of the same agent; a dead loop blocks the host until the run deadline.
- Limits (timeout, memory, sub-call counts, output caps) can be set on the preset row's `config`
  (or on the deployment row in the headless form); omitted fields keep their defaults.

Full documentation, limits, and the differences from DSH's built-in PTC executor:
<https://github.com/zhangliang0115/agent-plugin/tree/main/plugins/code-mode>.
