import { loginWithApiKey } from "./auth/api-key.ts";
import { completeOAuthLogin } from "./auth/oauth.ts";
import { loginWithPassword } from "./auth/password.ts";
import { authenticateHandshake } from "./auth/websocket.ts";
import { router } from "./http.ts";
import { rejectDisabledUsers } from "./middleware/reject-disabled.ts";

router.post("/login", async (req, res) => res.json(await loginWithPassword(req.body.email ?? "", req.body.password ?? "")));
router.get("/oauth/callback", async (req, res) => res.json(await completeOAuthLogin(req.query.code ?? "")));
router.post("/login/api-key", rejectDisabledUsers, (req, res) => res.json(loginWithApiKey(req.header("x-api-key") ?? "")));
router.upgrade("/ws", (req, res) => res.json(authenticateHandshake(req.query.token ?? "")));
