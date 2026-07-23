# Debug: pipeline aiohttp missing

- Session: `pipeline-aiohttp-missing`
- Status: `[OPEN]`
- Symptom: 点击“提取 SOCKS5”后第 3 步显示“检测失败”。
- Runtime evidence: 线上 `/api/pipeline` 返回 `ModuleNotFoundError: No module named 'aiohttp'`，检测进程退出码 1。

## Hypotheses

1. Python 依赖安装在虚拟环境，但运行检测时调用了系统 Python。
2. 虚拟环境未加入容器 PATH。
3. GitHub Actions 构建的镜像没有使用当前 Dockerfile。
4. 服务器仍运行旧镜像。

## Evidence log

- Pre-fix: 线上 `/api/pipeline` 明确返回 `/app/cf_quality_checker.py` 第 19 行 `ModuleNotFoundError: No module named 'aiohttp'`。
- Repository: Dockerfile 将依赖安装到 `/opt/venv`，但后端原先只按命令名调用 `python3`，未硬性绑定虚拟环境解释器。
- Deployment: 线上镜像中的 `python3` 无法导入 aiohttp，证明运行时解释器与依赖安装环境不一致，或仍为旧镜像。
- Fix: Docker 构建时执行模块导入校验；容器设置 `PYTHON_BIN=/opt/venv/bin/python`；所有检测进程强制使用该解释器。
- Static verification: `node --check server.cjs`、`git diff --check` 和编辑器诊断均通过。
- Post-fix runtime evidence 1: `/opt/venv/bin/python` 成功导入 aiohttp 3.14.2；系统 `/usr/bin/python3` 导入失败。
- Post-fix runtime evidence 2: 修复解释器后暴露 `FileNotFoundError: /app/socks-checker.py`，确认 Dockerfile 漏复制动态依赖。
- Post-fix runtime evidence 3: 临时补入 `socks-checker.py` 后，线上流水线成功执行 6 个代理的质量检测，并正常输出 CF 挑战页、HTTP 403 等检测结果；`/api/health` 返回 `active:false`，任务正常结束。
- Permanent fix: Dockerfile 已复制 `socks-checker.py`，构建时验证 Python 模块；server.cjs 强制使用虚拟环境解释器。
