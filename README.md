# MeetingNote

基于 Next.js、Electron 和 FastAPI/FunASR 的 Windows 会议转写桌面应用。

当前版本支持：
- 音频文件上传与排队转写
- 任务进度轮询与历史任务列表
- 暂停、取消、继续、失败重试
- 意外中断后的任务恢复
- Markdown 编辑与纯文本导出

## 技术栈

- 前端：Next.js 16 + React 19
- 桌面壳：Electron
- 后端：FastAPI
- 语音识别：FunASR
- 任务存储：SQLite

## 项目结构

- `src/app/page.tsx`：主页面，任务列表、任务详情、控制按钮
- `src/lib/tasks.ts`：前端任务模型与 API 调用
- `src/app/globals.css`：全局样式与任务状态样式
- `electron/main.js`：Electron 主进程，负责启动前端与 ASR 服务
- `services/asr_server/server.py`：FastAPI + 任务队列 + ASR 推理
- `services/asr_server/requirements.txt`：Python 依赖

## 安装依赖

先安装 Node.js 依赖：

```powershell
npm install
```

再安装 Python 依赖：

```powershell
python -m pip install -r .\services\asr_server\requirements.txt
```

## 开发模式

```powershell
npm run dev
```

开发模式会：
- 启动 Next.js 开发服务器
- 启动 Electron
- Electron 先加载前端页面
- 前端页面出现后，再启动本地 ASR 服务

## 生产构建

```powershell
npm run dist
```

构建产物位于 `dist/`。

## 启动顺序

为了避免首屏长时间白屏，当前启动顺序是：

1. Electron 先显示轻量启动页
2. Next.js 前端页面可访问后进入首页
3. 首页出现后，Electron 再启动本地 ASR 服务
4. ASR 初始化或模型准备过程通过首页右下角状态提示展示

这意味着：
- 进入首页不代表 ASR 已经完全就绪
- 上传任务时，如果模型仍在初始化，任务会先等待，不会直接误标为完成

## 数据存储

应用数据默认存储在本地用户目录：

- Windows：`%LOCALAPPDATA%\MeetingNote`

其中包括：
- `meetingnote.db`：任务数据库
- `uploads/`：上传后的音频文件
- `process-spawn.log`：子进程启动日志
- `asr-server.log` / `asr-server.err.log`：ASR 服务日志

也可以通过环境变量覆盖数据目录：

```powershell
$env:MEETINGNOTE_DATA_DIR="D:\MeetingNoteData"
```

## 模型与音频处理

默认模型：

- `FunAudioLLM/Fun-ASR-Nano-2512`

说明：
- 模型初始化在服务启动后异步进行，不阻塞前端页面显示
- 音频会在后端做规范化和分段处理
- 当前任务控制采用“在进度检查点响应”的方式
- 长音频在分段处理中点击暂停时，会保持“暂停中”，并在当前片段结束后真正停下

## 任务状态

前端当前使用的主要状态：

- `queued`：等待中
- `processing`：转录中
- `pausing`：暂停中，等待当前处理片段结束
- `paused`：已暂停
- `resuming`：重启中，正在恢复任务处理
- `cancelled`：已取消
- `failed`：失败
- `completed`：已完成

## 意外中断恢复

如果应用或 ASR 服务意外退出：

- SQLite 中未完成的 `queued / processing / pausing` 任务会在下次启动时重新恢复到真实任务队列
- 恢复后的任务会显示为等待继续处理
- 恢复任务支持继续暂停、取消、重试

## 当前接口

### 健康与模型

- `GET /health`
- `POST /api/model/download`
- `GET /api/model/download_status`

### 转写

- `POST /api/transcribe`
  兼容旧接口，直接上传并返回 `segments + markdown`

### 任务接口

- `POST /api/transcribe/jobs`
- `GET /api/transcribe/jobs`
- `GET /api/transcribe/jobs/{job_id}`
- `PATCH /api/transcribe/jobs/{job_id}`
- `POST /api/transcribe/jobs/{job_id}/pause`
- `POST /api/transcribe/jobs/{job_id}/cancel`
- `POST /api/transcribe/jobs/{job_id}/resume`
- `POST /api/transcribe/jobs/{job_id}/retry`

## 常见问题

### 1. 进入首页后为什么还会看到右下角初始化提示？

因为首页优先展示，ASR 在后面异步启动。这是有意设计，用来减少白屏时间。

### 2. 为什么任务上传后没有立刻开始转写？

可能原因：
- ASR 服务仍在启动
- 模型仍在初始化或下载
- 前面已有排队任务

这时任务会保持等待，而不是误标为完成。

### 3. 暂停为什么不是立刻生效？

暂停是“安全暂停”：
- 点击后先进入 `暂停中`
- 当前处理片段结束后再真正切到 `已暂停`

### 4. 哪些文件不建议提交到仓库？

通常不建议提交：
- 本地数据库文件
- `tsconfig.tsbuildinfo`
- 运行日志
- 大型二进制运行产物

## 备注

当前 README 以本地开发与桌面运行说明为主，后续如果你愿意，我还可以继续补：
- 发布流程
- GitHub 提交流程
- 打包 EXE 的依赖说明
- 故障排查手册
