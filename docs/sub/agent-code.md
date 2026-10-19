# Agent code panel

Dock panel "Agent code" (bar: ComfyUI > Agent code). It shows the code agentY makes, read-only, with
Python/JS/TS/JSON/shell/Markdown highlighting, line numbers, a Copy button and a Wrap switch. The list on
top is newest first: title, language, source (the tool), conversation, turn, time. A dot on the ComfyUI
bar button says new code arrived while the panel was closed.

![Agent code panel](../images/agent-code-panel.png)

Where it comes from (agentY side, `src/utils/code_sink.py`): `run_script` and `run_python_node` code, files
written with a code extension (custom nodes included), source-code arguments of MCP tools (Remotion
compositions), and fenced blocks in the agent's reply. Identical snippets are kept once.

Text files: pick a text/code file in the file browser (kind "Text & code") and it opens in this panel.

Routes: `POST /bepic/code` (a snippet in; pushed live as `bepic.code.update`), `GET /bepic/code` (recent
snippets, so a freshly opened viewer has the history), `GET /bepic/text?path=` (a file from an allowed
folder). Snippets are kept in memory per ComfyUI session. To add "edit and send back" later, call
`viewer.codePanelAddAction({label, run(snippet)})`.
