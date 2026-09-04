/**
 * Порт до хостингу коду: гілки, PR, згодом статуси CI й мерж.
 *
 * Окремо від `Board` навмисно. Дошка — це про квитки, forge — про код. GitHub
 * поєднує їх в одному API, і від того легко зліпити в один інтерфейс; але
 * задачі можуть жити в Trello, де PR не існує, а код — на GitHub. Тоді дошка,
 * змушена реалізувати `openPullRequest`, віддавала б заглушку з помилкою.
 */
export interface Forge {
  /**
   * Пуш гілки. Живе тут, а не в модулі git, бо потребує облікових даних —
   * а хто ними володіє, знає лише адаптер постачальника.
   */
  pushBranch(input: { cwd: string; branch: string; remote: string }): Promise<void>;

  openPullRequest(input: {
    branch: string;
    title: string;
    body: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
}
