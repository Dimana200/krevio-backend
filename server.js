import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import cors from "cors";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

const upload = multer({
  storage: multer.memoryStorage()
});

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

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Няма файл" });
    }
    const fileName = Date.now() + "-" + req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;
    res.json({ url: fileUrl, key: fileName });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Качването се провали" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on port " + PORT));
