import { Panel } from '../src/skill/panel.js';
import { Popover } from '../src/skill/popover.js';
import { ReadingLibrary } from '../src/ext/library.js';

export const answer = String.raw`布里尔损失（Brier loss）就是预测概率与实际结果之间的平方误差。
\[
L_{\text{Brier}}=(q-c)^2
\]
其中，\(q\) 是模型估计“当前答案正确”的概率；\(c\) 是实际结果，答对为 1，答错为 0。

- 答错时：报 90% 把握，损失为 \(0.9^2=0.81\)。
- 答对时：报 90% 把握，损失为 \((0.9-1)^2=0.01\)。

## 总体表现

$$\frac{1}{N}\sum_{i=1}^{N}(q_i-c_i)^2$$

| 指标 | 定义 |
| :--- | ---: |
| 单次误差 | $L_i=(q_i-c_i)^2$ |
| 完美预测 | $L=0$ |

> [!TIP]
> 看平均表现，不要只看一次结果。

- [x] 理解概率校准
- [ ] 检查模型是否过度自信

矩阵与对齐：
$$\begin{pmatrix}q_1&c_1\\q_2&c_2\end{pmatrix}$$
$$\begin{aligned}L_1&=(0.9-0)^2=0.81\\L_2&=(0.9-1)^2=0.01\end{aligned}$$

长公式应在内部横向滚动：
$$\mathcal{L}=${Array.from({ length: 24 }, (_, i) => `q_{${i + 1}}^2`).join('+')}$$

支持 ~~删除线~~、**重点** 和脚注[^brier]。

[^brier]: Brier score 是适当评分规则。`;

const record = { id: 'math-demo', action: 'explain', urlKey: location.href, url: location.href, title: 'Brier loss 与概率校准',
  text: document.getElementById('selection').textContent, value: answer, anchor: { start: 0, end: 20, exact: 'Brier loss' },
  createdAt: 1, updatedAt: 1, extra: { question: '解释下这个 loss', history: [{ at: 1, value: String.raw`之前的公式：$q^2$` }] } };
const panel = new Panel({ getItems: () => [], getLookups: kind => kind === 'explain' ? [record] : [],
  getStats: () => ({ position: 0, quote: 0, fuzzy: 0, orphan: 0 }), getNote: () => '', isOnline: () => false,
  outbox: () => 0, positionOf: () => 0, isOrphan: () => false, colorOf: () => '#efc36a', getLookupSupplement: () => '', api: {} });
const popover = new Popover({ name: 'markdown-qa', title: '解释', input: true, onSubmit: () => {} });
function showAnswer() {
  document.getElementById('library').hidden = true;
  panel.ui.width = 390; panel.toggle(true, false); panel.select('explain');
  popover.open({ left: 45, right: 450, top: 180, bottom: 210, width: 405, height: 30 }, record.text);
  popover.$('q').value = record.extra.question; popover.answer(answer);
}
document.getElementById('show-answer').onclick = showAnswer;
document.getElementById('theme').onclick = () => document.body.classList.toggle('dark');
let library;
document.getElementById('show-library').onclick = async () => {
  popover.close(); panel.toggle(false, false);
  const mount = document.getElementById('library'); mount.hidden = false;
  mount.dataset.theme = document.body.classList.contains('dark') ? 'dark' : 'light';
  if (!library) library = new ReadingLibrary(mount, { snapshot: async () => ({ events: [record], assets: [] }) });
  await library.refresh();
};
showAnswer();
