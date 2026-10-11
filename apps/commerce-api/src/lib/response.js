export function ok(response, data = null, message = "OK", status = 200) {
  response.status(status).json({
    code: "SUCCESS",
    message,
    data,
  });
}

export function fail(response, status, code, message) {
  response.status(status).json({
    code,
    message,
    data: null,
  });
}
