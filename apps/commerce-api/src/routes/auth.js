import express from "express";

import { getBearerToken } from "../lib/auth.js";
import { fail, ok } from "../lib/response.js";

export const authRouter = express.Router();

authRouter.post("/register", async (request, response, next) => {
  try {
    const { email, password, displayName } = request.body || {};
    const user = await request.app.locals.repository.createUser({
      email,
      password,
      displayName,
    });
    const session = await request.app.locals.repository.createSession(user.id);
    ok(
      response,
      {
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      },
      "Registered",
      201,
    );
  } catch (error) {
    if (error.code === "INVALID_PARAM") {
      fail(response, 400, error.code, error.message);
      return;
    }
    if (error.code === "CONFLICT") {
      fail(response, 409, error.code, error.message);
      return;
    }
    next(error);
  }
});

authRouter.post("/login", async (request, response, next) => {
  try {
    const { email, password } = request.body || {};
    const user = await request.app.locals.repository.authenticate({ email, password });
    const session = await request.app.locals.repository.createSession(user.id);
    ok(response, {
      user,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (error.code === "UNAUTHORIZED") {
      fail(response, 401, error.code, error.message);
      return;
    }
    next(error);
  }
});

authRouter.get("/me", async (request, response, next) => {
  try {
    const token = getBearerToken(request);
    const user = await request.app.locals.repository.getUserBySessionToken(token);
    if (!user) {
      fail(response, 401, "UNAUTHORIZED", "Not signed in");
      return;
    }
    ok(response, { user });
  } catch (error) {
    next(error);
  }
});
