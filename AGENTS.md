# ChatGPT Local Coder — Agent Onboarding

MCP host local: đọc/ghi file, chạy lệnh, git, skills, delegate sang CLI khác.
Dùng với ChatGPT Developer Mode hoặc bất kỳ MCP client nào. Chạy native trên
Windows, macOS và Linux.

## Lần đầu kết nối — gọi ngay 2 tool này

1. **`agent_status`** — xem profile quyền đang bật, workspace roots, audit log
2. **`project_context`** — đọc AGENTS.md, README, CLAUDE.md trong project

Đừng đoán quyền. `agent_status` nói chính xác cái gì được phép.

## Tool profile — đọc trước khi gọi tool

Profile mặc định là **`slim`**: chỉ **27 tool** được expose. Profile `full` có
**53 tool**. Bảng bên dưới liệt kê cả 53; tool đánh dấu **†** **chỉ có ở
`full`** — gọi nó dưới profile mặc định sẽ trả về `Tool not found`, đó không
phải lỗi server.

Bật full: `chatgpt-local-coder up --tool-profile full`, hoặc đặt
`CHATGPT_TOOL_PROFILE=full`.

Nếu không chắc tool nào đang có, xem `tools/list` của client — đó là danh sách
thật, không phải bảng này.

## Quyền truy cập

Profile mặc định là **`workspace`**:

| Profile | Đọc | Ghi | Lệnh shell |
|---|---|---|---|
| **`workspace`** *(mặc định)* | mọi nơi | **chỉ trong workspace roots** | được phép |
| `open` | mọi nơi | mọi nơi | được phép |
| `readonly` | mọi nơi | bị chặn | bị chặn |

- Ghi ra ngoài workspace roots sẽ bị **từ chối** — đây là hành vi đúng, không
  phải lỗi server. Nếu thật sự cần, báo user đổi profile hoặc thêm root; đừng
  tìm đường lách.
- Đọc thì không giới hạn path ở cả ba profile.
- `agent_status` cho biết root nào đang có hiệu lực (`permission_description`
  ghi rõ root được ghi). `list_allowed_directories`† chi tiết hơn nhưng chỉ có ở
  profile `full`.

**Cảnh báo phạm vi:** `workspace` chỉ giới hạn **tool file**. Lệnh shell đã được
duyệt chạy với **toàn quyền của user** trên máy — `npm`, `python`, hay một
subshell có thể chạm tới mọi thứ user chạm được. Không có sandbox nào ở đây.
`agent_delegate` cũng vậy: CLI được gọi chạy dưới quyền user với cấu hình riêng
của nó.

### Rule import từ agent khác

Host đọc `~/.claude/settings.json`, `~/.codex/config.toml`, và cấu hình của Grok
/ OpenCode. **Chỉ đọc, không bao giờ ghi.**

- `permissions.deny` import về **luôn được áp dụng**.
- `permissions.allow` import về **không bao giờ nới rộng** profile — chỉ giảm số
  lần hỏi trong phạm vi profile đã cho phép.

Nếu một tool bị chặn kèm tên rule, đó là `deny` từ file nguồn. Gọi
`settings_status`† để biết rule nào, từ file nào — tool này chỉ có ở profile
`full`. Dưới `slim`, báo user chạy `chatgpt-local-coder settings show`.

## ChatGPT: tránh popup + lỗi "Luôn cho phép phải kết nối lại"

### Cách đúng (làm TRƯỚC khi chat)

1. **Settings → Apps → Connectors** → chọn connector
2. Đặt quyền app: **Chỉ hỏi trước thay đổi quan trọng**
3. Bấm **Refresh** connector (sau mỗi lần update server)
4. Mở chat mới, tag connector, rồi mới gửi prompt

### KHÔNG bấm "Luôn cho phép" trên popup

Đây là bug/UI ChatGPT: bấm **Luôn cho phép** thường **đóng MCP session** → tunnel
log `stream canceled` → phải kết nối lại. Thay vào đó bấm **Cho phép một lần**,
hoặc cấu hình quyền ở **Settings → Apps**.

### Lỗi tunnel `stream canceled by remote`

Bình thường khi server restart giữa chừng, khi ChatGPT đóng stream SSE sau khi
đổi quyền, hoặc khi tunnel URL đổi mà chưa update connector.

**Fix:** giữ server + tunnel chạy ổn định. Nếu restart → Refresh connector + chat
mới. Dùng OpenAI Secure MCP Tunnel (`chatgpt-local-coder tunnel connect`) để
`tunnel_id` cố định.

## Mapping Claude Code ↔ MCP này

| Claude Code | Tool ở đây | Ghi chú |
|---|---|---|
| `Read` | `read_text_file` | Có `offset`+`limit` (line numbers) |
| `Write` | `write_file` | |
| `Edit` | `edit_file` | Có `replace_all` |
| `MultiEdit` | `multi_edit` | |
| `Glob` | `glob` | Sort theo mtime |
| `Grep` | `grep` | content / files_with_matches / count |
| `LS` | `list_directory` | Có `ignore` globs |
| `Bash` | `run_command` | Lệnh ngắn, chờ xong |
| Background shell | `start_process` + `process_output` | |
| `Task` / subagent | `agent_delegate` | Fork sang `claude` / `codex` / `opencode` / `grok` |
| `Skill` | `skill_run` | Skill từ `~/.chatgpt-local-coder/skills` và các root khác |
| `Rewind` | `rewind` | `list` / `preview` / `restore` — undo edit qua checkpoint |
| — | `mcp_servers`, `mcp_tools`†, `mcp_call`† | Gọi MCP server khác trên máy (hub) |
| — | `settings_status`† | Xem cấu hình import từ agent nào, cái nào thắng |
| — | `apply_patch` | Codex/OpenAI style |
| — | `git_*`, `git_restore` | Chỉ `git_status`, `git_diff`, `git_add`, `git_commit`, `git_restore` có ở `slim`; còn lại là † |
| — | `project_context`, `remember` | Đọc/ghi bộ nhớ project |

† = chỉ có ở profile `full`.

**Không có trong MCP này** (dùng built-in của client hoặc MCP khác):
`WebSearch`, `WebFetch`, `NotebookEdit`, `LSP`.

## Sửa code — tool nào dùng khi nào

| Việc cần làm | Tool |
|---|---|
| Tìm file theo tên | `glob` |
| Tìm nội dung | `grep` |
| Đọc file | `read_text_file` |
| Liệt kê thư mục | `list_directory` |
| Sửa bằng diff/patch | `apply_patch` (ưu tiên) |
| Sửa nhiều đoạn | `multi_edit` |
| Sửa bằng regex | `replace_regex`† |
| Tạo file mới | `write_file` |
| Xóa / đổi tên | `delete_file`†, `move_file`† — dưới `slim` dùng `run_command` |
| Chạy lệnh ngắn | `run_command` |
| Build/test dài | `start_process` → `process_output` |
| Git | `git_status`, `git_diff`, `git_commit`, `git_restore` |
| Restore file từ commit | `git_restore` (không dùng `git_checkout` cho file) |
| Undo edits trong session | `rewind`: `list` → `preview` → `restore` (không track bash) |
| Switch branch | `git_checkout`† (chỉ branch) hoặc `git_branch`† action `switch` |
| Chạy skill đã cài | `skill_list` → `skill_read` → `skill_run` |
| Giao việc cho CLI khác | `agent_delegate` (`delegate_status`† chỉ có ở `full`) |

† = chỉ có ở profile `full`. Dưới `slim`, làm cùng việc đó bằng `run_command`.

## Lệnh shell khác nhau theo hệ điều hành

Host **không dịch** lệnh giữa các nền tảng. `run_command` chạy trên:

- **Windows:** `pwsh` nếu có, không thì `powershell.exe`
- **macOS:** `$SHELL` nếu là `zsh`/`bash`/`sh`, không thì `/bin/zsh`
- **Linux:** `$SHELL` nếu là `bash`/`zsh`/`sh`, không thì `/bin/sh`

`rm -rf build` chạy trên macOS/Linux; trên Windows là
`Remove-Item -Recurse -Force build`. Gọi `agent_status` để biết đang ở OS nào
trước khi viết lệnh dài.

## ChatGPT safety layer — tool bị chặn ngẫu nhiên

Một số tool wrapper đôi khi bị OpenAI chặn với *"Lệnh gọi công cụ này đã bị chặn
bởi cơ chế kiểm tra an toàn"* — **không phải lỗi server**. Cùng thao tác qua
`run_command` thường vẫn chạy được.

| Tool hay bị chặn | Fallback `run_command` |
|---|---|
| `git_push`† | `git push -u origin <branch>` |
| `git_checkout`† | `git switch <branch>` |
| `git_restore` | `git restore -- <files>` |
| `delete_directory`† | `rm -rf <path>` / `Remove-Item -Recurse -Force <path>` |

Tool response có thể chứa `run_command_fallback` — dùng lệnh đó nếu wrapper bị chặn.

**Ổn định:** `git_status`, `git_diff`, `git_add`, `git_commit` (có ở cả hai
profile), `git_log`†, `git_branch`†, `git_stash`†, `git_reset`†, `git_pull`†.

## Format `apply_patch` (Codex-style)

```
@@
-old line to remove
+new line to add
 context line unchanged
```

Hoặc unified diff chuẩn:

```
@@ -10,3 +10,4 @@
 context
-old
+new
```

Tham số: `{ "path": "src/foo.ts", "patch": "...", "dry_run": false }`

Dùng `dry_run: true` để xem diff trước khi ghi.

## Đường dẫn file

- Dùng path tuyệt đối, hoặc relative từ workspace root đầu tiên.
- Ghi chỉ được trong workspace roots dưới profile `workspace`.
- Gọi `agent_status` nếu gặp "Access denied" — `permission_description` nói rõ
  root nào đang có hiệu lực. (`list_allowed_directories`† chỉ có ở `full`.)
- So sánh path phân biệt hoa thường trên Linux, **không** phân biệt trên Windows
  và macOS.

## Khởi động server

```bash
chatgpt-local-coder init --workspace /duong/dan/project
chatgpt-local-coder doctor
chatgpt-local-coder up                 # foreground, kèm tunnel
chatgpt-local-coder up --no-tunnel     # chỉ server
```

Chạy nền thay vì foreground:

```bash
chatgpt-local-coder service install    # systemd user unit / LaunchAgent / schtasks
chatgpt-local-coder tunnel connect     # service không quản tunnel
```

**Lần đầu dùng tunnel:** `chatgpt-local-coder tunnel init` — tải và verify
`tunnel-client`, tạo alias. Lấy credential ở
[Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) và
lưu vào secret store hoặc biến môi trường, **không** đặt literal trên command
line.

> `tunnel connect` **khởi động runtime nền như một side effect**. Đừng gọi nó chỉ
> để xem help — dùng `chatgpt-local-coder tunnel --help`.

Health check: `http://127.0.0.1:3000/health` | Admin UI: `http://127.0.0.1:3001/ui`

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| Access denied khi ghi | Path nằm ngoài workspace roots. Báo user thêm root hoặc đổi profile — đừng lách. |
| Tool bị chặn kèm tên rule | `permissions.deny` import từ agent khác. `settings_status`† xem nguồn, hoặc báo user chạy `chatgpt-local-coder settings show`. |
| `Tool not found` | Tool đó là † — chỉ có ở profile `full`. Dùng `run_command` hoặc báo user chạy `up --tool-profile full`. |
| Patch context not found | Đọc file trước; thêm context lines (dòng bắt đầu bằng space) |
| ChatGPT hỏi quyền mỗi lần | Refresh connector; đặt quyền ở Settings → Apps (không bấm "Luôn cho phép") |
| Connection failed | `chatgpt-local-coder status`; server + tunnel phải cùng chạy, URL phải HTTPS |
| Lệnh chạy được ở máy khác, ở đây thì không | Shell khác nhau theo OS. Xem `docs/cross-platform.md`. |

Chẩn đoán tổng quát: `chatgpt-local-coder doctor`.
