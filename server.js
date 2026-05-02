import express from "express";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import busboy from "busboy";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.options("*", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  next();
});

const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "13.0" }));

app.post("/upload", async (req, res) => {
  console.log("=== UPLOAD HIT ===");
  try {
    const videoChunks = []; const thumbChunks = [];
    let title = "", description = "", access = "free", token = "";
    let videoName = "video.mp4", videoMime = "video/mp4";
    let hasThumb = false;

    const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

    bb.on("field", (name, val) => {
      if (name === "title")       title       = val;
      if (name === "description") description = val;
      if (name === "access")      access      = val;
      if (name === "token")       token       = val;
    });

    bb.on("file", (name, file, info) => {
      if (name === "video") {
        videoName = info.filename || "video.mp4";
        videoMime = info.mimeType || "video/mp4";
        file.on("data", (chunk) => videoChunks.push(chunk));
      } else if (name === "thumbnail") {
        hasThumb = true;
        file.on("data", (chunk) => thumbChunks.push(chunk));
      } else {
        file.resume();
      }
    });

    bb.on("finish", async () => {
      try {
        if (!token) return res.status(401).json({ error: "Не си влязъл." });
        const { data, error } = await sbAuth.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
        const user = data.user;
        if (!title) return res.status(400).json({ error: "Няма заглавие." });
        if (videoChunks.length === 0) return res.status(400).json({ error: "Няма файл." });

        const fileBuffer = Buffer.concat(videoChunks);
        const ext = videoName.split(".").pop() || "mp4";
        const key = `videos/${user.id}/${Date.now()}.${ext}`;

        console.log("Uploading video to R2, size:", fileBuffer.length);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: key,
          Body: fileBuffer, ContentType: videoMime,
          CacheControl: "public, max-age=31536000",
        }));
        const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

        // Качи thumbnail ако е изпратен
        let thumbnailUrl = null;
        if (hasThumb && thumbChunks.length > 0) {
          const thumbBuffer = Buffer.concat(thumbChunks);
          const thumbKey = `thumbnails/${user.id}/${Date.now()}.jpg`;
          console.log("Uploading thumbnail, size:", thumbBuffer.length);
          await s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: thumbKey,
            Body: thumbBuffer, ContentType: "image/jpeg",
            CacheControl: "public, max-age=31536000",
          }));
          thumbnailUrl = `${process.env.R2_PUBLIC_URL}/${thumbKey}`;
        }

        await sb.from("videos").insert({
          user_id: user.id, title,
          description: description || "",
          file_url: fileUrl,
          access_level: access || "free",
          thumbnail_url: thumbnailUrl,
        });

        console.log("Upload OK:", fileUrl, "| thumb:", thumbnailUrl);
        res.json({ fileUrl, thumbnailUrl });
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

app.delete("/delete-video", async (req, res) => {
  console.log("=== DELETE VIDEO HIT ===");
  try {
    const { token, fileUrl, videoId } = req.body;
    if (!token) return res.status(401).json({ error: "Не си влязъл." });
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
    const user = data.user;

    const { error: dbErr } = await sb.from("videos").delete().eq("id", videoId).eq("user_id", user.id);
    if (dbErr) return res.status(500).json({ error: dbErr.message });

    const key = fileUrl.replace(process.env.R2_PUBLIC_URL + "/", "");
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

    console.log("Deleted:", videoId, key);
    res.json({ ok: true });
  } catch(e) {
    console.error("Delete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v13.0 on port ${PORT}`));
