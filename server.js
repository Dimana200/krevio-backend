import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import busboy from "busboy";

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "11.0" }));

app.post("/upload", async (req, res) => {
  console.log("=== UPLOAD HIT ===");
  try {
    const chunks = [];
    let title = "", description = "", access = "free";
    let fileName = "video.mp4", mimeType = "video/mp4", token = "";

    const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

    bb.on("field", (name, val) => {
      if (name === "title") title = val;
      if (name === "description") description = val;
      if (name === "access") access = val;
      if (name === "token") token = val;
    });

    bb.on("file", (name, file, info) => {
      fileName = info.filename || "video.mp4";
      mimeType = info.mimeType || "video/mp4";
      file.on("data", (chunk) => chunks.push(chunk));
    });

    bb.on("finish", async () => {
      try {
        if (!token) return res.status(401).json({ error: "Не си влязъл." });

        const { data, error } = await sbAuth.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
        const user = data.user;

        if (!title) return res.status(400).json({ error: "Няма заглавие." });
        if (chunks.length === 0) return res.status(400).json({ error: "Няма файл." });

        const fileBuffer = Buffer.concat(chunks);
        const ext = fileName.split(".").pop() || "mp4";
        const key = `videos/${user.id}/${Date.now()}.${ext}`;

        console.log("Uploading to R2, size:", fileBuffer.length);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: key,
          Body: fileBuffer, ContentType: mimeType,
        }));

        const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        await sb.from("videos").insert({
          user_id: user.id, title,
          description: description || "",
          file_url: fileUrl,
          access_level: access || "free",
          thumbnail_url: null,
        });
        console.log("Upload OK:", fileUrl);
        res.json({ fileUrl });
      } catch(e) {
        console.error("Upload error:", e.message);
        res.status(500).json({ error: e.message });
      }
    });

    req.pipe(bb);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v11.0 on port ${PORT}`));
