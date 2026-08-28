// userscript 载体入口：直接 fetch（token 编译进产物），启动。
// 扩展载体走 src/ext/app.js —— 那边先把传输层换成 service worker 再启动。
import { boot } from './main.js';

// 浏览器 每次点击都会重新执行userscript：第一次直接展开，之后把重复执行当作
// 同一个面板的开关，而不是再注入一套 UI。
boot({ initialPanelOpen: true, toggleExisting: true });
