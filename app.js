import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import AWS from "aws-sdk";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs/promises";
import { createReadStream } from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: "us-east-1",
});

const s3 = new AWS.S3();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

app.post("/voice", async (req, res) => {
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
  const speechResult = req.body.SpeechResult;
  console.log("Received speech:", speechResult);
  const response = new twilio.twiml.VoiceResponse();
  const aiResponse = await getAIResponse(speechResult);
  const file = await synthesizeSpeech(aiResponse);
  console.log("file", file);
  response.play(file);
  const gather = response.gather({
    input: "speech",
    timeout: 30,
    speechTimeout: "auto", // Let Twilio decide based on pauses in speech
    action: "/process_speech",
  });
  //   gather.say("Do you need anything else", { voice: "alice" });
  res.type("text/xml");
  res.send(response.toString());
});



// Function to transcribe audio using OpenAI's Whisper
async function transcribeAudio(url) {
  const response = await fetch(url);
  const audioBuffer = await response.arrayBuffer();
  const audioFilePath = "/tmp/recording.wav";
  await fs.writeFile(audioFilePath, Buffer.from(audioBuffer));
  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(audioFilePath),
  });

  await fs.unlink(audioFilePath); // Delete the temporary file
  return transcription.text;
}

// Function to get AI response from OpenAI
async function getAIResponse(text) {
  const completion = await openai.chat.completions.create({
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
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

// synthesizeSpeech("Hi can i help you place an order please?").then(console.log);

app.listen(8080, () => {
  console.log("Server is running on port 8080");
});
