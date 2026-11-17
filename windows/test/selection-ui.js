'use strict';
// 选择操作与堆栈随辅助工具运行真实 Electron 页面回归。
const path=require('node:path');
process.env.OPENALL_TOOL_SCREEN_DIR ||= path.resolve(__dirname,'../artifacts/selection');
require('./tool-ui.test.js');
