import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDR-vxzq1HaxGSp21DcjLZ6NAu1VHede9M",
  authDomain: "dan-tracker-fc4fe.firebaseapp.com",
  projectId: "dan-tracker-fc4fe",
  storageBucket: "dan-tracker-fc4fe.firebasestorage.app",
  messagingSenderId: "267676783887",
  appId: "1:267676783887:web:601fce61004417f5d0da7a"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
