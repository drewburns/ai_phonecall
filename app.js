import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import AWS from "aws-sdk";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs/promises";
import { createReadStream } from "fs";
import redis from "redis";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
});

const s3 = new AWS.S3();
const redisClient = redis.createClient({
  host: "localhost", // Default is '127.0.0.1'
  port: 6379, // Default is 6379
});

redisClient.on("error", (err) => {
  console.error("Redis client error:", err);
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

app.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  await redisClient.del(callSid); // Clear previous context
  const response = new twilio.twiml.VoiceResponse();
  const file = await synthesizeSpeech(
    "Thanks for calling, how can I help you?"
  );
  response.play(file);
  const gather = response.gather({
    input: "speech",
    timeout: 30,
    speechTimeout: "auto", // Let Twilio decide based on pauses in speech
    action: "/process_speech",
  });
  res.type("text/xml");
  res.send(response.toString());
});

app.post("/process_speech", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  console.log("Received speech:", speechResult);

  // Retrieve previous conversation context
  const previousContext = await getContext(callSid);

  // Add current user input to the context
  const currentContext = [
    ...previousContext,
    { role: "user", content: speechResult },
  ];

  // Get AI response
  const aiResponse = await getAIResponse(currentContext);

  // Add AI response to the context
  currentContext.push({ role: "assistant", content: aiResponse });

  // Save the updated context
  await saveContext(callSid, currentContext);

  const file = await synthesizeSpeech(aiResponse);
  console.log("file", file);
  const response = new twilio.twiml.VoiceResponse();
  response.play(file);
  const gather = response.gather({
    input: "speech",
    timeout: 30,
    speechTimeout: "auto", // Let Twilio decide based on pauses in speech
    action: "/process_speech",
  });
  res.type("text/xml");
  res.send(response.toString());
});

async function getContext(callSid) {
  return new Promise((resolve, reject) => {
    redisClient.get(callSid, (err, data) => {
      if (err) return reject(err);
      if (data) return resolve(JSON.parse(data));
      return resolve([]);
    });
  });
}

async function saveContext(callSid, context) {
  return new Promise((resolve, reject) => {
    redisClient.set(callSid, JSON.stringify(context), (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Function to get AI response from OpenAI
async function getAIResponse(context) {
  const completion = await openai.chat.completions.create({
    messages: context,
    temperature: 0.9,
    max_tokens: 1000,
    model: "gpt-3.5-turbo",
  });

  return completion.choices[0].message["content"];
}

// Function to synthesize speech using Neets.ai
async function synthesizeSpeech(text) {
  const response = await fetch("https://api.neets.ai/v1/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.NEETS_API_KEY,
    },
    body: JSON.stringify({
      text: text,
      voice_id: "vits-eng-1",
      params: {
        model: "vits",
      },
    }),
  });

  const buffer = await response.arrayBuffer();
  const tempFilePath = "/tmp/neets_demo.mp3";
  await fs.writeFile(tempFilePath, Buffer.from(buffer));

  const fileContent = await fs.readFile(tempFilePath);

  const params = {
    Bucket: "card.overlayx.co",
    Key: `neets_demo_${Date.now()}.mp3`,
    Body: fileContent,
    ContentType: "audio/mpeg",
  };

  const data = await s3.upload(params).promise();
  await fs.unlink(tempFilePath);

  const urlParams = {
    Bucket: params.Bucket,
    Key: params.Key,
    Expires: 600,
  };

  const url = s3.getSignedUrl("getObject", urlParams);
  return url;
}

app.listen(8080, () => {
  console.log("Server is running on port 8080");
});
