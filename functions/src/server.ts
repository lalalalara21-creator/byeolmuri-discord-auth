import express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "byeolmuri-discord-auth",
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
