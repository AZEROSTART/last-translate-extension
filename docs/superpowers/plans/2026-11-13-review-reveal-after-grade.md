# 复习卡「先评级、再揭晓、可改判」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点「忘了 / 模糊 / 认识」后原地展开释义与完整例句，允许改判，点「下一张」才写库一次。

**Architecture:** 复习卡分成 `idle` 与 `graded` 两个状态。评级只写入面板内的 `state.pending`，不碰存储；`commit()` 在「下一张」时发送唯一一次 `review-answer`，用最终选择定档。四选一复用同一提交点，但档位由对错决定、不可改判。`load()` 在 `pending` / `ended` 期间不重建队列，避免存储推送或切 tab 把结果卡顶掉。

**Tech Stack:** TypeScript、Vitest + jsdom、Playwright、Chrome MV3 侧栏。

**Spec:** `docs/superpowers/specs/2026-11-12-review-reveal-after-grade-design.md`

## Global Constraints

- 只改 `src/panel/review.ts`、`src/styles/panel.css`、对应测试与文档。
- 不改 `src/shared/srs.ts`、`src/shared/spot.ts`、`src/shared/types.ts`、`src/background/learning.ts`。
- 一次复习**恰好一次** `review-answer`；`grade` 必须是用户最终看到答案后选的那一档。
- 点评级、改判、看答案都不得产生网络/存储写入。
- 四选一的 `grade` 由对错派生（答对 `good`、答错 `again`），不提供改判按钮。
- 新增 DOM 类名沿用现有 `ilmt-review-*` 前缀；不新增依赖。
- 提交信息用英文、conventional 前缀（`feat:` / `test:` / `docs:`）。

## Review Focus

- 点了评级但没点「下一张」时，存储里的 `box` / `dueAt` 必须完全没变。
- 改判后写库的是最后一档，不是第一次点的那档。
- 四选一答对也必须停在结果卡，不能直接跳到下一张。
- graded 期间收到 `chrome.storage.onChanged` 或切 tab 再来，结果卡不能消失、不能换词。
- 「结束」必须把当前已选的档记进去，且迟到的刷新不能把结束页顶回下一张卡。
- 提交失败必须留在本卡、保留选择，不能推进队列。

---

### Task 1: 普通卡状态机（评级 → 揭晓 → 下一张）

**Files:**
- Modify: `src/panel/review.ts`
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: 现有 `deps.answer`、`deps.getState`、`deps.now`、`state.queue`。
- Produces（模块内，不导出）:
  - `ReviewState` 新增字段 `pending: LearningGrade | null`、`ended: boolean`
  - `function answerShown(): boolean`
  - `function pickGrade(grade: LearningGrade): void`
  - `function commit(): Promise<void>`
  - `function renderNext(card: HTMLElement): void`
  - `async function endRound(): Promise<void>`
  - `renderAnswer(word, card, label?)` 改为按 `answerShown()` 决定是否展开

- [ ] **Step 1: 写失败测试**

先删掉 `describe("mountReview")` 里的旧用例 `sends the chosen grade and advances to the next card`（它断言点完评级立即出队，正是要改掉的行为，后面第三个新用例覆盖同样的路径）。

然后在 `tests/unit/panel-review.test.ts` 末尾追加：

```ts
describe("reveal after grading", () => {
  it("reveals the meaning on the same card as soon as a grade is picked", async () => {
    const { root, view, answer } = mount([
      word(1, {
        surface: "outlive",
        glosses: [{ lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW }],
      }),
    ]);
    await view.refresh();
    expect(root.querySelector(".ilmt-review-meaning")).toBeNull();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("outlive");
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 1");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
    expect(answer).not.toHaveBeenCalled();
  });

  it("lets the user change the grade before committing", async () => {
    const { root, view, answer } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    expect(
      root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed"),
    ).toBe("true");

    root.querySelector<HTMLButtonElement>('[data-grade="again"]')!.click();

    expect(answer).not.toHaveBeenCalled();
    expect(
      root.querySelector('[data-grade="good"]')!.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      root.querySelector('[data-grade="again"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(root.querySelector(".ilmt-review-meaning")).toBeTruthy();
  });

  it("commits exactly once with the final grade on 下一张", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-grade="hard"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "review-answer", id: "en:word1", grade: "hard" }),
    );
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("2 / 2");
    });
  });

  it("lists every stored language under the primary meaning", async () => {
    const { root, view } = mount([
      word(1, {
        glosses: [
          { lang: "zh", meaning: "比……存在得更久", source: "translation", at: NOW },
          { lang: "ja", meaning: "より長く生き残る", source: "translation", at: NOW },
        ],
        glossLang: "zh",
      }),
    ]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();

    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比……存在得更久");
    expect(root.querySelector(".ilmt-review-meaning-more")?.textContent).toContain(
      "日语 · より長く生き残る",
    );
  });

  it("keeps the card and the selection when the answer call fails", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();
    answer.mockImplementationOnce(
      async () => ({ ok: false }) as unknown as { ok: true; word: LearningWord },
    );

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(root.querySelector(".ilmt-review-progress")?.textContent).toBe("1 / 2");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
  });

  it("does not rebuild the queue while a grade is pending", async () => {
    const words = [word(1), word(2)];
    const { root, view } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    await view.refresh();

    expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    expect(root.querySelector(".ilmt-review-next")).toBeTruthy();
  });

  it("commits the pending grade when the round is ended", async () => {
    const words = [word(1), word(2)];
    const { root, view, answer } = mount(words);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: "en:word1", grade: "good" }));
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-done")).toBeTruthy();
    });
  });

  it("offers 继续复习 after an explicit end", async () => {
    const { root, view } = mount([word(1)]);
    await view.refresh();

    root.querySelector<HTMLButtonElement>('[data-grade="good"]')!.click();
    root.querySelector<HTMLButtonElement>(".ilmt-review-end")!.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-continue")).toBeTruthy();
    });

    root.querySelector<HTMLButtonElement>(".ilmt-review-continue")!.click();

    await vi.waitFor(() => {
      expect(root.querySelector(".ilmt-review-word")?.textContent).toBe("word1");
    });
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run tests/unit/panel-review.test.ts`

Expected: FAIL。`[data-grade="good"]` 点击后立即出队，因此 `.ilmt-review-meaning` 为 `null`、`.ilmt-review-next` 不存在、`answer` 已被调用一次；`.ilmt-review-continue` 不存在。

- [ ] **Step 3: 实现**

改 `src/panel/review.ts`，按下面六处落。

1）`ReviewState` 增加两个字段（放在 `revealed` 之后）：

```ts
  /** Grade picked on the current card; written to storage only on 下一张. */
  pending: LearningGrade | null;
  /** True after "结束": a late storage reload must not resurrect the queue. */
  ended: boolean;
```

`mountReview` 的初始 state 里加 `pending: null, ended: false,`。

2）`renderAnswer` 改为按 `answerShown()` 决定展开，并给答案区加 `aria-live`：

```ts
  function answerShown(): boolean {
    return state.revealed || state.pending !== null;
  }

  function renderAnswer(word: LearningWord, card: HTMLElement, label = "想不起来，看答案"): void {
    if (!answerShown()) {
      // ...现有 reveal 按钮，原样保留...
      return;
    }

    // ...现有 primary / rest / 完整原句拼装，原样保留...
    answer.setAttribute("aria-live", "polite");
    // ...card.appendChild(answer) 原样保留
  }
```

3）把 `submit()` 换成「只选择、不写库」的 `pickGrade()`，并新增 `commit()`：

```ts
  function pickGrade(grade: LearningGrade): void {
    if (!current() || state.busy || destroyed) return;
    state.pending = grade;
    render();
  }

  async function commit(): Promise<void> {
    const word = current();
    const grade = state.pending;
    if (!word || grade === null || state.busy || destroyed) return;
    state.busy = true;
    render();

    let response: ReviewAnswerResponse;
    try {
      response = await deps.answer({
        type: "review-answer",
        id: word.id,
        grade,
        glossLang: state.glossLang || word.glossLang,
        ...(state.spotResult
          ? { spot: true, spotCorrect: state.spotResult.correct }
          : {}),
      });
    } catch {
      response = { ok: false } as unknown as ReviewAnswerResponse;
    }
    if (destroyed) return;
    state.busy = false;

    if (!response || response.ok !== true) {
      // Stay on this card with the selection intact; 下一张 retries.
      render();
      flushPending();
      return;
    }

    state.answered += 1;
    if (grade === "good") state.correct += 1;
    state.queue.shift();
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    render();
    flushPending();
  }
```

4）`renderGrades` 改成调用 `pickGrade` 并标记当前选择（不再 `submit`）：

```ts
  function renderGrades(card: HTMLElement): void {
    const grades = document.createElement("div");
    grades.className = "ilmt-review-grades";
    const buttons: Array<[LearningGrade, string]> = [
      ["again", "忘了"],
      ["hard", "模糊"],
      ["good", "认识"],
    ];
    for (const [grade, label] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ilmt-review-grade";
      button.dataset.grade = grade;
      button.textContent = label;
      button.disabled = state.busy;
      const active = state.pending === grade;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => pickGrade(grade));
      grades.appendChild(button);
    }
    card.appendChild(grades);
  }

  function renderNext(card: HTMLElement): void {
    const next = document.createElement("button");
    next.type = "button";
    next.className = "ilmt-review-next";
    next.textContent = "下一张";
    next.disabled = state.busy;
    next.addEventListener("click", () => void commit());
    card.appendChild(next);
  }
```

5）`renderCard()` 的普通卡分支：

```ts
    const question = shouldSpotCheck(word)
      ? buildSpotQuestion(
          word,
          state.all?.words ?? [],
          state.glossLang || word.glossLang,
          spotSeed(word),
        )
      : null;

    if (question) {
      renderSpot(word, card, question);
      return;
    }

    renderAnswer(word, card);
    renderGrades(card);
    if (state.pending !== null) renderNext(card);
```

同时把「结束」按钮的处理器改成：

```ts
    end.addEventListener("click", () => void endRound());
```

并新增：

```ts
  async function endRound(): Promise<void> {
    // Latch first: the commit below triggers a storage reload that must not
    // put the next card back on screen.
    state.ended = true;
    if (state.pending !== null) await commit();
    state.queue = [];
    state.revealed = false;
    state.pending = null;
    state.spotResult = null;
    state.busy = false;
    render();
  }
```

6）`load()` 开头加两条守卫：

```ts
  async function load(): Promise<void> {
    if (state.busy) {
      pendingReload = true;
      return;
    }
    // "结束" wins over any late reload until the user resumes the round.
    if (state.ended) return;
    // A graded card owns the view; replay this reload after 下一张.
    if (state.pending !== null) {
      pendingReload = true;
      return;
    }
    // ...以下原样...
  }
```

7）`renderFinish()` 末尾追加「继续复习」，并让它清掉本轮计数：

```ts
    if (state.ended) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "ilmt-review-continue";
      again.textContent = "继续复习";
      again.addEventListener("click", () => {
        state.ended = false;
        state.answered = 0;
        state.correct = 0;
        void refresh();
      });
      card.appendChild(again);
    }
```

8）筛选 chip 的处理器里加 `state.ended = false;`（在 `state.answered = 0;` 之前），让切语言能重新开一轮。

9）`src/panel/review.ts` 里删掉旧的 `submit()`。**本任务先不要动 `submitSpot()` / `finishCard()`**，四选一仍走旧路径，下一任务再统一。

- [ ] **Step 4: 运行并确认通过**

Run: `npx vitest run tests/unit/panel-review.test.ts`
Expected: PASS，5 个原有用例 + 8 个新增用例 = 13 个全绿。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/panel/review.ts tests/unit/panel-review.test.ts
git commit -m "feat: reveal the meaning after grading a review card"
```

---

### Task 2: 四选一接同一提交点

**Files:**
- Modify: `src/panel/review.ts`
- Test: `tests/unit/panel-review.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `commit`、`renderNext`、`state.spotResult`。
- Produces: `function pickSpotOption(choice: number, question: SpotQuestion): void`；`renderSpot(word, card, question)` 在答前给「查看完整例句与全部释义」，答后总是展开答案并给「下一张」。

- [ ] **Step 1: 改写两个现有四选一用例为失败测试**

把 `describe("spot check integration")` 里的两个用例整体替换成：

```ts
describe("spot check integration", () => {
  const spotWords = (): LearningWord[] => [
    word(1, {
      surface: "outlive",
      checksSinceSpot: 2,
      dueAt: NOW - 5 * HOUR,
      glosses: [{ lang: "zh", meaning: "比…活得久", source: "translation", at: NOW }],
    }),
    word(2, { glosses: [{ lang: "zh", meaning: "实际的", source: "translation", at: NOW }] }),
    word(3, { glosses: [{ lang: "zh", meaning: "当前的", source: "translation", at: NOW }] }),
    word(4, { glosses: [{ lang: "zh", meaning: "生存", source: "translation", at: NOW }] }),
  ];

  it("turns the third review into a four-way question that waits for 下一张", async () => {
    const { root, view, answer } = mount(spotWords());
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    expect(options).toHaveLength(4);
    options.find((option) => option.textContent === "比…活得久")!.click();

    // Correct answers must stay on the card and show the meaning too.
    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-grade")).toBeNull();
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比…活得久");
    expect(root.querySelector(".ilmt-review-spot-note")).toBeNull();

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "review-answer",
          id: "en:word1",
          grade: "good",
          spot: true,
          spotCorrect: true,
        }),
      );
    });
  });

  it("shows the correction and the answer after a wrong choice", async () => {
    const { root, view, answer } = mount(spotWords());
    await view.refresh();

    const options = [...root.querySelectorAll<HTMLButtonElement>(".ilmt-review-option")];
    options.find((option) => option.textContent === "实际的")!.click();

    expect(answer).not.toHaveBeenCalled();
    expect(root.querySelector(".ilmt-review-spot-note")?.textContent).toContain("比…活得久");
    expect(root.querySelector(".ilmt-review-meaning")?.textContent).toContain("比…活得久");

    root.querySelector<HTMLButtonElement>(".ilmt-review-next")!.click();

    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith(
        expect.objectContaining({ grade: "again", spot: true, spotCorrect: false }),
      );
    });
  });
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `npx vitest run tests/unit/panel-review.test.ts`

Expected: FAIL。选项点击后 `answer` 已被调用（旧行为立即写库）；答对时 `.ilmt-review-next` 不存在、`.ilmt-review-meaning` 为 `null`。

- [ ] **Step 3: 实现**

先加一个只做选择、不写库的函数：

```ts
  function pickSpotOption(choice: number, question: SpotQuestion): void {
    if (!current() || state.busy || state.spotResult || destroyed) return;
    const correct = choice === question.answer;
    state.spotResult = { chosen: choice, correct };
    state.pending = correct ? "good" : "again";
    render();
  }
```

再把 `renderSpot()` 改成：

```ts
  function renderSpot(word: LearningWord, card: HTMLElement, question: SpotQuestion): void {
    const result = state.spotResult;
    const options = document.createElement("div");
    options.className = "ilmt-review-options";
    question.options.forEach((meaning, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ilmt-review-option";
      button.dataset.index = String(index);
      button.textContent = meaning;
      button.disabled = state.busy || result !== null;
      if (result) {
        if (index === question.answer) button.classList.add("is-correct");
        if (index === result.chosen && !result.correct) button.classList.add("is-wrong");
      }
      button.addEventListener("click", () => pickSpotOption(index, question));
      options.appendChild(button);
    });
    card.appendChild(options);

    if (result && !result.correct) {
      const note = document.createElement("p");
      note.className = "ilmt-review-spot-note";
      note.textContent = `正确答案：${question.options[question.answer]}`;
      card.appendChild(note);
    }

    // One tap away before the check; always open once the card is graded.
    renderAnswer(word, card, "查看完整例句与全部释义");

    if (result) renderNext(card);
  }
```

确认 `review.ts` 里不再出现 `submit(`, `submitSpot(`, `finishCard(`（旧的 `submitSpot` 与 `finishCard` 整个删掉，四选一改走 `pickSpotOption` → `commit`）。

- [ ] **Step 4: 运行并确认通过**

Run: `npx vitest run tests/unit/panel-review.test.ts`
Expected: PASS。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/panel/review.ts tests/unit/panel-review.test.ts
git commit -m "feat: unify spot checks with the reveal-then-commit flow"
```

---

### Task 3: 选中态样式与长路径 E2E

**Files:**
- Modify: `src/styles/panel.css`
- Modify: `tests/e2e/learning.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `.ilmt-review-grade.is-active`、`.ilmt-review-continue`。
- Produces: 无导出。

- [ ] **Step 1: 加样式**

在 `src/styles/panel.css` 的 `.ilmt-review-grade:disabled` 之前插入：

```css
.ilmt-review-grade.is-active {
  background: rgba(45, 212, 191, 0.16);
  border-color: var(--ilmt-accent);
}
```

把 `.ilmt-review-next {` 选择器改成 `.ilmt-review-next,\n.ilmt-review-continue {`，让「继续复习」复用同一套按钮外观。

- [ ] **Step 2: 改 E2E 断言**

在 `tests/e2e/learning.spec.ts` 里，把这段：

```ts
      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-sentence")).toContainText("____");
      await panel.locator(".ilmt-review-reveal").click();
      await expect(panel.locator(".ilmt-review-meaning")).toContainText("比……存在得更久");
      await expect(panel.locator(".ilmt-review-meaning-more")).toContainText("sobrevivir a");

      await panel.locator('[data-grade="good"]').click();
```

换成：

```ts
      await panel.locator('[data-grade="good"]').click();

      // The card stays put and opens the answer; nothing is written yet.
      await expect(panel.locator(".ilmt-review-word")).toHaveText("outlive");
      await expect(panel.locator(".ilmt-review-meaning")).toContainText("比……存在得更久");
      await expect(panel.locator(".ilmt-review-meaning-more")).toContainText("sobrevivir a");
      await expect(panel.locator(".ilmt-review-next")).toBeVisible();
      await expect
        .poll(async () => (await readWords(extension!.worker))[0]?.box)
        .toBe(0);

      await panel.locator(".ilmt-review-next").click();
```

（`await panel.locator(".ilmt-review-continue").count();` 是一行无副作用的存在性检查，可保留也可删；保留用于确认结束按钮没有提前出现。）

- [ ] **Step 3: 构建并跑 E2E**

Run: `npm run build && npx playwright test tests/e2e/learning.spec.ts --reporter=line`
Expected: 1 passed。若 `box` 在点「下一张」前变成 1，说明写库时机没改对，回到 Task 1。

- [ ] **Step 4: 跑全部 E2E**

Run: `npx playwright test --reporter=line`
Expected: 9 passed。

- [ ] **Step 5: 提交**

```bash
git add src/styles/panel.css tests/e2e/learning.spec.ts
git commit -m "test: cover the review reveal flow end to end"
```

---

### Task 4: 文档与交付验证

**Files:**
- Modify: `docs/superpowers/specs/2026-11-12-review-reveal-after-grade-design.md`（状态行）
- Modify: `docs/superpowers/specs/2026-11-12-learning-loop-design.md`（§5.2 交叉引用）
- Modify: `README.md`（复习功能描述）
- Modify: `docs/delivery-verification.md`（追加记录）

- [ ] **Step 1: 标记实现完成**

把新 spec 的 `- 状态：待批准` 改成 `- 状态：已实现（2026-11-13）`。

在 `2026-11-12-learning-loop-design.md` §5.2 开头加一行：

```md
> 2026-11-13 修订：点「忘了 / 模糊 / 认识」后原地揭晓释义与完整例句，可改判，点「下一张」才计入间隔。见 `2026-11-12-review-reveal-after-grade-design.md`。
```

- [ ] **Step 2: 更新 README**

把第 19 行的学习闭环描述补一句：

```md
- **学习闭环**：悬停卡片上的地鼠可点击收录单词，词进入本地间隔复习；侧栏「复习」按 10 分钟 → 1 天 → 3 天 → 7 天 → 16 天 → 35 天推进，每第 3 次复习变成四选一抽查。点评级后原地展开释义（多语言并列）与完整例句，还可以改判；点「下一张」才计入间隔。
```

- [ ] **Step 3: 跑自动门禁**

Run: `npm run verify:delivery`
Expected: 单测、`tsc`、build、`check-build` 全部通过。

- [ ] **Step 4: 执行 P0 主流程**

按 `docs/delivery-verification.md` 第 0–2 节执行：重载扩展、`article.html` 按 `Opt+A`、检查 10/10 双语、再按恢复、popup、划词解释、控制台无红色报错。

复习路径不在 P0 主流程内，用 Task 3 的 Playwright 用例覆盖（真实 Chromium + 已加载扩展）。

- [ ] **Step 5: 追加验证记录**

在 `docs/delivery-verification.md` 末尾追加：

```md
## 9. 本次验证记录（2026-11-13，复习卡揭晓）

- 自动门禁：通过（单测 N/N、`tsc`、build、`check-build`）
- Opt+A 翻译：通过（10/10）
- 双语在原文下方：通过
- 再按 Opt+A 恢复：通过
- popup：通过
- 侧栏解释：通过
- 控制台：通过（无 error）
- 复习揭晓：通过（Playwright `learning.spec.ts`：点评级后答案出现、`box` 仍为 0、点「下一张」后变 1）
```

N 用第 3 步的实际数字填。

- [ ] **Step 6: 提交**

```bash
git add README.md docs/delivery-verification.md docs/superpowers/specs
git commit -m "docs: document the review reveal flow"
```
