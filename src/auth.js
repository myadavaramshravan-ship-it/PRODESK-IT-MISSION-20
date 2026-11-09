import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export function createAuthHandlers({ db, jwtSecret }) {
  return {
    async register(req, res, next) {
      try {
        const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = req.body?.password;
        if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            typeof password !== "string" || password.length < 12 || password.length > 128) {
          return res.status(400).json({
            error: "Provide a name, valid email, and password between 12 and 128 characters."
          });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        let result;
        try {
          result = await db.createUser({ name, email, passwordHash });
        } catch (error) {
          if (error.code === "DUPLICATE_EMAIL") {
            return res.status(409).json({ error: "An account with that email already exists." });
          }
          throw error;
        }

        const user = { id: result.id, name, email };
        return res.status(201).json({ token: issueToken(user.id, jwtSecret), user });
      } catch (error) {
        next(error);
      }
    },

    async login(req, res, next) {
      try {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = req.body?.password;
        const userRecord = await db.findUserByEmail(email);
        const validPassword = userRecord && typeof password === "string" &&
          await bcrypt.compare(password, userRecord.passwordHash);
        if (!validPassword) {
          return res.status(401).json({ error: "Invalid email or password." });
        }

        const user = { id: userRecord.id, name: userRecord.name, email: userRecord.email };
        return res.json({ token: issueToken(user.id, jwtSecret), user });
      } catch (error) {
        next(error);
      }
    }
  };
}

export function requireAuth(jwtSecret) {
  return (req, res, next) => {
    const authorization = req.get("authorization") ?? "";
    const [scheme, token] = authorization.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "A valid bearer token is required." });
    }

    try {
      const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
      const userId = Number(payload.sub);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(401).json({ error: "Invalid authentication token." });
      }
      req.user = { id: userId };
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired authentication token." });
    }
  };
}

function issueToken(userId, jwtSecret) {
  return jwt.sign({}, jwtSecret, {
    algorithm: "HS256",
    subject: String(userId),
    expiresIn: "2h"
  });
}
