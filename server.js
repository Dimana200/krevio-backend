import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON
);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

app.get("/", (req, res) => {
  res.json({ status: "Krevio Backend OK", version: "5.0" });
});

app.post("/presign", async (req, res) => {
  console.log("=== PRESIGN HIT ===");

  const token = req.headers.authorization?.replace("Bearer ", "");
  console.log("Token:", token ? "OK" : "MISSING");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });

  try {
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data?.user) {
      console.log("Auth failed:", error?.message);
      return res.status(401).json({ error: "Невалиден токен." });
    }

    const user = data.user;
    const { fileName, mimeType, title, description, access } = req.body;
    console.log("File:", fileName, mimeType, title);

    if (!fileName || !mimeType || !title) {
      return res.status(400).json({ error: "Липсват данни." });
    }

    const ext = fileName.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const fileUrl   = `${process.env.R2_PUBLIC_URL}/${key}`;

    await sb.from("videos").insert({
      user_id:      user.id,
      title:        title,
      description:  description || "",
      file_url:     fileUrl,
      access_level: access || "free",
    });

    console.log("Success:", key);
    res.json({ uploadUrl, fileUrl, key });

  } catch(e) {
    console.log("Error:", e.message);
    res.status(500).json({ error: "Сървърна грешка." });
  }
});

app.listen(PORT, () => {
  console.log(`Krevio Backend v5.0 on port ${PORT}`);
});
