# MeetingNote (Next.js + Electron + FunASR)

Windows 会议转写桌面应用（EXE）：
- 文件上传转写
- 转写任务进度显示
- 说话人 + 时间戳分段
- Markdown 实时编辑 + 导出

## 1) 安装依赖

```powershell
npm install
python -m pip install -r .\services\asr_server\requirements.txt
```

## 2) 开发模式

```powershell
npm run dev
```

## 3) 生产构建

```powershell
npm run dist
```

构建产物在 `dist/`。

## 4) 模型说明

服务默认尝试加载：`FunAudioLLM/Fun-ASR-Nano-2512`。
若本机环境未成功加载 FunASR 模型，服务会回退到 mock 结果，前端流程仍可联调。

## 5) 当前接口

- `GET /health`
- `POST /api/transcribe`：兼容旧接口，上传音频文件并直接返回 `segments + markdown`
- `POST /api/transcribe/jobs`：创建文件转写任务
- `GET /api/transcribe/jobs/{job_id}`：查询任务进度与结果

## 6) 目录

- `src/app/page.tsx`：主 UI（文件上传、进度、编辑、导出）
- `electron/main.js`：Electron 主进程，启动 UI 与 Python 服务
- `services/asr_server/server.py`：FastAPI + FunASR 推理服务
