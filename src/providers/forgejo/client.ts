export interface ForgejoUserIdentity {
  id: number;
  login: string;
}

export interface ForgejoRepositoryIdentity {
  id: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
}

export interface ForgejoCollaboratorPermission {
  permission: string;
  roleName: string;
  user: ForgejoUserIdentity;
}

export interface ForgejoConnectionClient {
  currentUser(connectionId: string): Promise<ForgejoUserIdentity>;
  repositoryPermission(input: {
    connectionId: string;
    owner: string;
    repo: string;
    username: string;
  }): Promise<ForgejoCollaboratorPermission>;
  listVisibleRepositories(connectionId: string): Promise<readonly ForgejoRepositoryIdentity[]>;
}

export interface ForgejoContentsClient {
  readFile(input: {
    connectionId: string;
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<{ sha: string; content: string; encoding: string } | undefined>;
  createFile(input: {
    connectionId: string;
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
    newBranch?: string;
  }): Promise<{ sha: string }>;
  updateFile(input: {
    connectionId: string;
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    sha: string;
    branch?: string;
  }): Promise<{ sha: string }>;
}

export interface ForgejoIssuesClient {
  createIssueComment(input: {
    connectionId: string;
    owner: string;
    repo: string;
    index: number;
    body: string;
  }): Promise<{ id: number }>;
  createIssueReaction(input: {
    connectionId: string;
    owner: string;
    repo: string;
    index: number;
    content: string;
  }): Promise<void>;
  createCommentReaction(input: {
    connectionId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: string;
  }): Promise<void>;
}
