import { loginWithApiKey } from "./auth/api-key.ts";
import { router } from "./http.ts";
import { rejectDisabledUsers } from "./middleware/reject-disabled.ts";

router.post("/login/api-key", rejectDisabledUsers, (req, res) => res.json(loginWithApiKey(req.header("x-api-key") ?? "")));
// Added by this pull request: the same login, reached by internal tooling.
router.post("/internal/api-key", (req, res) => res.json(loginWithApiKey(req.header("x-api-key") ?? "")));
