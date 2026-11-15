import { expect, type Page } from "@playwright/test";

const GITHUB = "/e2e/github";
const AUTHORIZE_PAGE = `${GITHUB}/login/oauth/authorize`;
const INSTALL_PAGE = `${GITHUB}/apps/paseo/installations/new`;
const CHOOSER = "/connections/github";

export interface GitHubAccountChoice {
  account: string;
  /** The line under the account that says what connecting it means, or why it cannot. */
  explanation: string | RegExp;
  connectable: boolean;
}

/**
 * The pages a person crosses between pressing Connect GitHub and landing back on Hub: GitHub's
 * authorize and install pages, and Hub's account chooser. Every journey that connects GitHub
 * walks them through here, so a journey reads as the decisions a person makes and nothing else.
 */
export class GitHubConnectFlow {
  private readonly visited: string[] = [];

  constructor(private readonly page: Page) {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.visited.push(new URL(frame.url()).pathname);
    });
  }

  /**
   * GitHub asks a person to authorize the App the first time only; after that it sends them
   * straight back. Waits for wherever the round trip comes to rest and answers the prompt if
   * that is where it stopped.
   */
  async authorizeWhenAsked(): Promise<void> {
    await this.page.waitForURL(
      (url) =>
        url.pathname === AUTHORIZE_PAGE ||
        url.pathname === INSTALL_PAGE ||
        url.pathname === CHOOSER ||
        (!url.pathname.startsWith(GITHUB) && url.searchParams.has("result")),
    );
    if (new URL(this.page.url()).pathname !== AUTHORIZE_PAGE) return;
    await this.page.getByRole("link", { name: "Authorize paseo" }).click();
    await this.page.waitForURL((url) => url.pathname !== AUTHORIZE_PAGE);
  }

  /** Declines GitHub's authorize prompt. */
  async cancelAuthorization(): Promise<void> {
    await this.page.waitForURL((url) => url.pathname === AUTHORIZE_PAGE);
    await this.page.getByRole("link", { name: "Cancel" }).click();
  }

  async expectChooser(choices: readonly GitHubAccountChoice[]): Promise<void> {
    await expect(this.page).toHaveURL((url) => url.pathname === CHOOSER);
    await expect(
      this.page.getByRole("heading", { name: "Choose a GitHub account", level: 1 }),
    ).toBeVisible();
    const rows = this.page.getByRole("list", { name: "GitHub accounts" }).getByRole("listitem");
    await expect(rows).toHaveCount(choices.length);
    for (const choice of choices) {
      const row = rows.filter({ hasText: choice.account });
      await expect(row).toContainText(choice.explanation);
      await expect(row.getByRole("button", { name: `Connect ${choice.account}` })).toHaveCount(
        choice.connectable ? 1 : 0,
      );
    }
  }

  async choose(account: string): Promise<void> {
    await this.page
      .getByRole("list", { name: "GitHub accounts" })
      .getByRole("button", { name: `Connect ${account}` })
      .click();
  }

  async addAnotherAccount(): Promise<void> {
    await this.page.getByRole("button", { name: "Add another account" }).click();
    await expect(this.page).toHaveURL((url) => url.pathname === INSTALL_PAGE);
  }

  async cancelChooser(): Promise<void> {
    await this.page.getByRole("link", { name: "Cancel" }).click();
  }

  async expectInstallPage(): Promise<void> {
    await expect(this.page).toHaveURL((url) => url.pathname === INSTALL_PAGE);
    await expect(this.page.getByRole("heading", { name: "Install paseo", level: 1 })).toBeVisible();
  }

  /** Installs the App on an account from GitHub's install page. */
  async installOn(account: string): Promise<void> {
    await this.expectInstallPage();
    await this.page.getByRole("link", { name: `Install on ${account}` }).click();
  }

  /** A member who is not an owner can only ask an owner to install. */
  async requestFor(account: string): Promise<void> {
    await this.expectInstallPage();
    await this.page.getByRole("link", { name: `Request for ${account}` }).click();
  }

  /**
   * Connects an account however GitHub and Hub present it: from the chooser when the App is
   * already installed there, or through the install page when it is not.
   */
  async connect(account: string): Promise<void> {
    await this.authorizeWhenAsked();
    if (new URL(this.page.url()).pathname === CHOOSER) {
      await expect(this.page.getByRole("list", { name: "GitHub accounts" })).toBeVisible();
      const connect = this.page
        .getByRole("list", { name: "GitHub accounts" })
        .getByRole("button", { name: `Connect ${account}` });
      if ((await connect.count()) === 1) {
        await connect.click();
        return;
      }
      await this.addAnotherAccount();
    }
    await this.installOn(account);
  }

  /** Reaches GitHub's install page, through the chooser's "Add another account" if it shows. */
  async toInstallPage(): Promise<void> {
    await this.authorizeWhenAsked();
    if (new URL(this.page.url()).pathname === CHOOSER) await this.addAnotherAccount();
    await this.expectInstallPage();
  }

  /**
   * Sends Hub a setup return for an installation GitHub never offered this person, the way a
   * hand-edited URL would. Continues the attempt the install page belongs to.
   */
  async forgeSetupReturn(installationId: number): Promise<void> {
    await this.expectInstallPage();
    const installPage = new URL(this.page.url());
    const setup = new URL("/api/integrations/github/setup", installPage);
    setup.searchParams.set("state", installPage.searchParams.get("state") ?? "");
    setup.searchParams.set("installation_id", String(installationId));
    setup.searchParams.set("setup_action", "install");
    await this.page.goto(setup.toString());
  }

  expectInstallPageNotVisited(): void {
    expect(this.visited).not.toContain(INSTALL_PAGE);
  }
}
