// userscript 载体入口：直接 fetch（token 编译进产物），启动。
// 扩展载体走 src/ext/app.js —— 那边先把传输层换成 service worker 再启动。
import { boot } from './main.js';

boot();
