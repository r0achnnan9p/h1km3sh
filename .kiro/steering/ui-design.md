---
inclusion: fileMatch
fileMatchPattern: "**/*.css,**/*.html,**/public/**"
---

## UI Design Rules

本项目的 UI 规则以 `docs/design-system.md` 为唯一依据（深色底 + 玻璃浮层、Token 只在 `public/console.css` 的 `:root`、本地 JetBrains Mono 数字、图标优先、桌面铺满整屏）。各屏布局见 `docs/ui-glass-spec.md`。

改样式前必须先读这两份文件；不得引入未登记的颜色、圆角、阴影、字体或组件样式。旧版本里“不用玻璃质感 / 用 Inter / 小圆角 / 浅色主题”的规则已作废。
