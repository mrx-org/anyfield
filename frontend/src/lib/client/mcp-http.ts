import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type Transport, unwrapResult } from "./transport";

const STORE_PREFIX = "anyfield.oauth.";
const RETURN_PATH = `${STORE_PREFIX}returnPath`;

/** Thrown when a tool needed a login and the page is now on its way to GitHub. */
export class LoginRedirect extends Error {
  constructor() {
    super("Redirecting to login");
    this.name = "LoginRedirect";
  }
}

/**
 * Web app: MCP over HTTP to `/mcp`. Session tools go out without a token.
 * The first call of a login tool gets a 401; the SDK then runs the OAuth flow
 * (dynamic client registration, PKCE) and the page goes to GitHub and back.
 */
export class McpHttpTransport implements Transport {
  private client: Client | null = null;
  private http: StreamableHTTPClientTransport | null = null;
  readonly auth: BrowserOAuthProvider;

  constructor(private serverUrl: URL = new URL("/mcp", location.origin)) {
    this.auth = new BrowserOAuthProvider(new URL("/", location.origin).href);
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.http = new StreamableHTTPClientTransport(this.serverUrl, { authProvider: this.auth });
    const client = new Client({ name: "anyfield-web", version: "0.1.0" });
    await client.connect(this.http);
    this.client = client;
    return client;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      return unwrapResult(name, result as Parameters<typeof unwrapResult>[1]);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new LoginRedirect();
      throw e;
    }
  }

  get loggedIn(): boolean {
    return this.auth.tokens() !== undefined;
  }

  /** Call once at startup: completes a login if the page is the OAuth redirect target. */
  async completeLogin(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (!code || !this.auth.codeVerifierOrNull()) return;
    this.http ??= new StreamableHTTPClientTransport(this.serverUrl, { authProvider: this.auth });
    await this.http.finishAuth(code);
    this.auth.invalidateCredentials("verifier");
    this.client = null; // reconnect with the token
    const back = sessionStorage.getItem(RETURN_PATH) ?? "/";
    sessionStorage.removeItem(RETURN_PATH);
    history.replaceState(null, "", back);
  }

  logout(): void {
    this.auth.invalidateCredentials("tokens");
    this.client = null;
  }
}

class BrowserOAuthProvider implements OAuthClientProvider {
  constructor(readonly redirectUrl: string) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "anyfield web",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private get<T>(key: string): T | undefined {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  private set(key: string, value: unknown): void {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  }

  clientInformation = () => this.get<OAuthClientInformationMixed>("client");
  saveClientInformation = (info: OAuthClientInformationMixed) => this.set("client", info);
  tokens = () => this.get<OAuthTokens>("tokens");
  saveTokens = (tokens: OAuthTokens) => this.set("tokens", tokens);
  saveCodeVerifier = (v: string) => this.set("verifier", v);
  codeVerifierOrNull = () => this.get<string>("verifier") ?? null;

  codeVerifier(): string {
    const v = this.codeVerifierOrNull();
    if (!v) throw new Error("No PKCE code verifier saved");
    return v;
  }

  redirectToAuthorization(url: URL): void {
    sessionStorage.setItem(RETURN_PATH, location.pathname + location.hash);
    location.assign(url);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const keys = { all: ["client", "tokens", "verifier"], client: ["client"], tokens: ["tokens"], verifier: ["verifier"], discovery: [] }[scope];
    for (const k of keys) localStorage.removeItem(STORE_PREFIX + k);
  }
}
