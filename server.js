import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import cors from "cors";
import busboy from "busboy";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

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
  const bb = busboy({ headers: req.headers });
  let fileBuffer = [];
  let fileName = "";
  let fileMime = "";

  bb.on("file", (name, file, info) => {
    fileMime = info.mimeType;
    fileName = Date.now() + "-" + info.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    file.on("data", (data) => fileBuffer.push(data));
  });

  bb.on("close", async () => {
    try {
      const buffer = Buffer.concat(fileBuffer);
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: fileName,
        Body: buffer,
        ContentType: fileMime
      }));
      const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
      res.json({ url: fileUrl, key: fileName });
    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Качването се провали" });
    }
  });

  req.pipe(bb);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on port " + PORT));
