export interface Request {
  header(name: string): string | undefined;
  body: Record<string, string>;
  query: Record<string, string>;
}

export interface Response {
  status(code: number): Response;
  send(body: string): void;
  json(body: unknown): void;
}

export type Next = () => void;
export type Handler = (req: Request, res: Response, next: Next) => void | Promise<void>;

const routes: { method: string; path: string; handlers: Handler[] }[] = [];

export const router = {
  get: (path: string, ...handlers: Handler[]) => routes.push({ method: "GET", path, handlers }),
  post: (path: string, ...handlers: Handler[]) => routes.push({ method: "POST", path, handlers }),
  upgrade: (path: string, ...handlers: Handler[]) => routes.push({ method: "UPGRADE", path, handlers }),
};
