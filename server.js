const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Krevio backend работи 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
