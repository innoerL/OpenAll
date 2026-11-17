# OpenAll 文本对比编辑器

运行时使用两个 CodeMirror 6 `EditorView`，由 `diff-core.js` 的行对齐结果提供块级空白占位和差异装饰。占位属于 `StateField` 的 `Decoration.widget`，不会写入正文、复制内容或撤销记录。两侧关闭软换行并统一为 22 px 行高。字符差异仅计算可见行，整份文档的块级占位集合支持编辑器虚拟化与稳定滚动。

组合输入期间暂停重新比较和布局装饰；编辑事务、撤销与重做由 CodeMirror 处理。加载新的比较会重置历史，普通编辑和比较不会重建编辑器。输入换行统一为 LF，与原 textarea 的行为保持一致。

依赖版本锁定在 `package-lock.json`。在本目录执行以下命令可重建离线资源：

```sh
npm ci --ignore-scripts --cache ../.build/npm-cache
npm run build
```

生成 `../Resources/comparison-editor.js`，应用构建直接复制该文件，无需运行时网络。第三方许可保留在 `../Resources/ComparisonEditor-LICENSE.txt`。

`window.compareV2.verify()` 提供 WebKit 验收，覆盖编辑、撤销重做、组合输入生命周期、字符差异、块级占位、复制、滚动、长文本和主题。实际 macOS 输入法候选窗口的交互仍应进行手动验证。

官方参考：[块级装饰与 WidgetType](https://codemirror.net/docs/ref/#view.Decoration^widget)、[官方合并编辑器占位实现](https://github.com/codemirror/merge/blob/main/src/deco.ts)、[历史扩展](https://codemirror.net/docs/ref/#commands.history)。
