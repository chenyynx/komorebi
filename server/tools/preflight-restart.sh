#!/bin/sh
# dsh-cc-mgw 重启门禁（F5）—— 把规则「pm2 restart 自己前先问 pp」变成机器拦得住的退出码。
#
# 为什么存在：2026-09-10 我在部署流式修复时，明知网关有 1 个 claude 子进程仍执行了
# pm2 restart，掐断了 pp 正在手机上跑的回合；客户端等了一个永远不来的 turn/end
# 五分钟。"要先问"靠自觉不可靠，所以有了这个脚本。
#
# 用法：  sh tools/preflight-restart.sh
# 退出码：0 = 可以重启；3 = 有人在用 / 判不出来，先停下来问 pp
# 原则：  任何一项存疑都按"在用"处理（宁可慢，不要意外）。
set -u

MGW_PID_FILE="$HOME/.pm2/pids/dsh-cc-mgw-15.pid"
ADMIN="http://127.0.0.1:3090"
BUSY=0

echo "[preflight] dsh-cc-mgw 重启门禁  $(date '+%F %T')"

# 1) 进程与子进程：有 claude 子进程 = 有回合正在跑
if [ ! -f "$MGW_PID_FILE" ]; then
  echo "  ! 找不到 pid 文件 $MGW_PID_FILE：先 pm2 list 确认进程在不在，再动手"
  exit 3
fi
PID=$(cat "$MGW_PID_FILE")
KIDS=$(ps --ppid "$PID" -o pid= --no-headers 2>/dev/null | grep -c '[0-9]')
if [ "${KIDS:-0}" -gt 0 ]; then
  echo "  ✗ $KIDS 个 claude 子进程在跑（进行中的回合会被打断）："
  ps --ppid "$PID" -o pid=,etime=,args= --no-headers 2>/dev/null | cut -c1-96 | sed 's/^/      /'
  BUSY=1
else
  echo "  ✓ 子进程 0 个（没有进行中的回合）"
fi

# 2) 管理面视角：running / 排队中的会话（判不出来就按可疑处理）
SNAP=$(curl -s --max-time 3 "$ADMIN/mgw/sessions" 2>/dev/null)
if [ -z "$SNAP" ]; then
  echo "  ! 管理面无响应（$ADMIN/mgw/sessions）→ 无法判定，按在用处理"
  exit 3
fi
REPORT=$(printf '%s' "$SNAP" | python3 -c '
import json, sys
try:
    sessions = json.load(sys.stdin).get("sessions", [])
except Exception:
    print("UNREADABLE"); sys.exit(0)
live = [s for s in sessions if s.get("running")]
queued = [s for s in sessions if (s.get("queued") or 0) > 0]
print("OK 会话共 %d 条，进行中 %d，有排队 %d" % (len(sessions), len(live), len(queued)))
for s in live[:5]:
    sid = str(s.get("sessionId", ""))[:8]
    print("   running: %s queued=%s" % (sid, s.get("queued", 0)))
for s in queued[:5]:
    sid = str(s.get("sessionId", ""))[:8]
    print("   queued : %s 排着 %s 条（重启会丢弃）" % (sid, s.get("queued")))
if live or queued:
    print("BUSY")
')
echo "$REPORT" | sed 's/^/  /'
echo "$REPORT" | grep -q "^BUSY$" && BUSY=1
echo "$REPORT" | grep -q "^UNREADABLE$" && { echo "  ! 会话快照不可解析 → 按在用处理"; exit 3; }

# 3) 兜底提示：最近 1 分钟还在写的 transcript（可能含非本网关会话）
RECENT=$(find "$HOME/.claude/projects" -name "*.jsonl" -newermt "-60 seconds" 2>/dev/null | wc -l)
if [ "${RECENT:-0}" -gt 0 ]; then
  echo "  · 提示：$RECENT 份 CC transcript 最近 60 秒仍在写入（可能包含 claudio 等其他系统的会话）"
fi

if [ "$BUSY" -eq 1 ]; then
  echo "[preflight] 结论：✗ 不许重启 —— 先问 pp 有没有会话在跑"
  exit 3
fi
echo "[preflight] 结论：✓ 可以重启（无进行中回合、无排队消息）"
exit 0
