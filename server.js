import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import cors from "cors";

const app = express();

app.use(cors({ origin: "*" }));
app.options("*", cors());

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Krevio backend работи" });
});

app.post("/upload", (req, res) => {
  const chunks = [];
  let fileName = "upload-" + Date.now() + ".mp4";
  let contentType = req.headers["content-type"] || "video/mp4";

  req.on("data", chunk => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const buffer = Buffer.concat(chunks);
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: fileName,
        Body: buffer,
        ContentType: contentType
      }));
      const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
      res.json({ url: fileUrl });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Качването се провали" });
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on port " + PORT));
