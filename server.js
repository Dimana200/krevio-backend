import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "/tmp/", limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sbAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "8.0" }));

app.post("/upload", upload.single("video"), async (req, res) => {
  console.log("=== UPLOAD HIT ===");
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });

  try {
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });

    const user = data.user;
    const { title, description, access } = req.body;
    if (!req.file) return res.status(400).json({ error: "Няма файл." });
    if (!title) return res.status(400).json({ error: "Няма заглавие." });

    console.log("File received:", req.file.originalname, req.file.size);

    const ext = req.file.originalname.split(".").pop() || "mp4";
    const key = `videos/${user.id}/${Date.now()}.${ext}`;
    const fileBuffer = fs.readFileSync(req.file.path);

    console.log("Uploading to R2...");
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: req.file.mimetype || "video/mp4",
    }));

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    console.log("R2 upload OK:", fileUrl);

    const { error: dbError } = await sb.from("videos").insert({
      user_id: user.id,
      title: title,
      description: description || "",
      file_url: fileUrl,
      access_level: access || "free",
      thumbnail_url: null,
    });

    if (dbError) console.error("DB error:", dbError.message);
    else console.log("DB insert OK");

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.json({ fileUrl });

  } catch(e) {
    console.error("Upload error:", e.message);
    try { if(req.file) fs.unlinkSync(req.file.path); } catch(e2) {}
    res.status(500).json({ error: "Сървърна грешка: " + e.message });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v8.0 on port ${PORT}`));
