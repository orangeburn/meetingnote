export const designFoundations = {
  identity: {
    name: "Operational Console System",
    concept:
      "把语音转录工具做成冷峻、克制、可高频操作的控制台界面，视觉服从效率与状态识读。",
    keywords: ["operational", "neutral", "precise", "dense", "focused"],
  },
  principles: [
    {
      title: "信息先于装饰",
      description: "视觉重点优先给任务状态、文本内容和操作入口，装饰只负责建立气质，不抢主信息。",
    },
    {
      title: "层级通过密度拉开",
      description: "不用堆很多颜色做区分，而是通过字号、留白、边界强弱和表面明度建立阅读顺序。",
    },
    {
      title: "约束优先于自由发挥",
      description: "每个组件只保留少量可选变体，避免页面随着功能增长重新变回样式拼贴。",
    },
  ],
  typography: {
    display: "IBM Plex Sans",
    body: "IBM Plex Sans",
    scale: [
      { token: "display", usage: "页面主标题", value: "clamp(1.4rem, 2vw, 2rem)" },
      { token: "headline", usage: "模块标题 / 任务标题", value: "clamp(1.35rem, 1.6vw, 1.75rem)" },
      { token: "title", usage: "面板标题", value: "1.125rem" },
      { token: "body", usage: "正文 / 表单输入", value: "0.98rem" },
      { token: "meta", usage: "辅助信息 / 状态标签", value: "0.78rem" },
    ],
  },
  color: {
    canvas: "oklch(0.94 0.002 250)",
    panel: "oklch(0.97 0.002 250 / 0.94)",
    panelStrong: "oklch(0.985 0.002 250 / 0.98)",
    line: "oklch(0.68 0.003 250 / 0.52)",
    text: "oklch(0.24 0.003 250)",
    muted: "oklch(0.43 0.003 250)",
    accent: "oklch(0.4 0.003 90)",
    success: "oklch(0.57 0.04 150)",
    danger: "oklch(0.56 0.05 30)",
  },
  spacing: {
    rhythm: "12 / 18 / 28 / 44 / 72",
    rule: "同一层级内使用相近节奏，不同层级之间至少拉开一个档位。",
  },
  surfaces: [
    {
      name: "Canvas",
      usage: "页面底布和全局背景",
      rule: "纯色背景，不使用渐变和纹理。",
    },
    {
      name: "Shell Panel",
      usage: "页面主工作区容器",
      rule: "单层边框容器，避免多层卡片嵌套。",
    },
    {
      name: "Soft Panel",
      usage: "正文编辑区、信息块、浮层",
      rule: "比主壳层更轻，避免和顶层容器竞争。",
    },
  ],
  components: [
    {
      name: "Button",
      variants: ["primary", "secondary", "ghost"],
      rule: "一个区域最多一个 primary；次级操作统一用 secondary 或 ghost。",
    },
    {
      name: "Badge",
      variants: ["neutral", "processing", "success", "danger"],
      rule: "只表达状态，不承载复杂信息。",
    },
    {
      name: "Section Heading",
      variants: ["page", "panel"],
      rule: "统一由 eyebrow + title + optional description 组成，禁止每页发明新标题结构。",
    },
  ],
} as const;

export type DesignFoundation = typeof designFoundations;
