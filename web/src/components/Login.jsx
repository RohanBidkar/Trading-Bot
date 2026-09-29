import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useThemeColors, REDUCED_MOTION } from "../lib/theme.js";
import BlurText from "./bits/BlurText.jsx";
import DotGrid from "./bits/DotGrid.jsx";
import ShinyText from "./bits/ShinyText.jsx";
import Icon, { BrandMark } from "./Icon.jsx";

function messageFor(err) {
  if (err.status === 429) {
    const minutes = Math.max(1, Math.ceil((err.data?.retryAfter ?? 900) / 60));
    return { tone: "warn", text: `Too many wrong tries. Try again in ${minutes} min.` };
  }
  if (err.status === 401) {
    const left = err.data?.remaining;
    return { tone: "error", text: `That password didn't work.${left != null ? ` ${left} ${left === 1 ? "try" : "tries"} left.` : ""}` };
  }
  if (err.status === 503) return { tone: "warn", text: "The website password isn't set up yet. Add WEB_PASSWORD to the Worker." };
  return { tone: "error", text: "Couldn't reach the server. Check your connection and try again." };
}

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | checking | ok | leaving
  const [message, setMessage] = useState(null);
  const [shake, setShake] = useState(false);
  const [caps, setCaps] = useState(false);
  const input = useRef(null);
  const colors = useThemeColors(["--line-strong", "--accent"]);

  useEffect(() => { input.current?.focus(); }, []);

  const fail = msg => {
    setMessage(msg);
    setPhase("idle");
    setShake(true);
    input.current?.select();
  };

  const submit = async e => {
    e.preventDefault();
    if (phase !== "idle") return;
    if (!password) return fail({ tone: "error", text: "Enter the password to continue." });
    setPhase("checking");
    setMessage(null);
    try {
      await api.login(password);
      setPhase("ok");
      setTimeout(() => setPhase("leaving"), 550);
      setTimeout(onSuccess, 1000);
    } catch (err) {
      fail(messageFor(err));
    }
  };

  const onKey = e => setCaps(e.getModifierState?.("CapsLock") ?? false);

  return (
    <main className="login">
      <div className="login-bg" aria-hidden="true">
        {!REDUCED_MOTION && (
          <DotGrid dotSize={3} gap={22} baseColor={colors["--line-strong"]} activeColor={colors["--accent"]}
            proximity={130} shockRadius={220} shockStrength={4} resistance={700} returnDuration={1.4} />
        )}
      </div>
      <div className="login-vignette" aria-hidden="true" />

      <form
        className={`login-card ${shake ? "shake" : ""} ${phase === "leaving" ? "leaving" : ""}`}
        onSubmit={submit}
        onAnimationEnd={e => e.animationName === "shake" && setShake(false)}
        noValidate
      >
        <div className="login-mark"><BrandMark size={22} draw /></div>
        <BlurText text="Scanner Desk" className="login-title" delay={90} animateBy="letters" direction="bottom" stepDuration={0.28} />
        <p className="login-sub">Run the bank-stock scans and read the results. Enter the desk password to continue.</p>

        <label className="field-label" htmlFor="password">Password</label>
        <div className={`field ${message?.tone === "error" ? "error" : ""}`}>
          <span className="field-icon"><Icon name="lock" size={16} /></span>
          <input
            id="password"
            ref={input}
            type={show ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••"
            value={password}
            onChange={e => { setPassword(e.target.value); if (message?.tone === "error") setMessage(null); }}
            onKeyDown={onKey}
            onKeyUp={onKey}
            disabled={phase !== "idle"}
            aria-invalid={message?.tone === "error"}
            aria-describedby="login-msg"
          />
          <button type="button" className="reveal" onClick={() => setShow(s => !s)} aria-label={show ? "Hide password" : "Show password"}>
            <Icon name={show ? "eyeOff" : "eye"} size={16} />
          </button>
        </div>

        <div id="login-msg" className={`login-msg ${message?.tone ?? (caps ? "warn" : "")}`} aria-live="polite">
          {message ? <span key={message.text}>{message.text}</span> : caps ? <span>Caps Lock is on.</span> : null}
        </div>

        <button type="submit" className={`btn-unlock ${phase === "ok" || phase === "leaving" ? "ok" : ""}`} disabled={phase !== "idle"}>
          {phase === "checking" && <><span className="spinner" aria-hidden="true" /> Checking…</>}
          {(phase === "ok" || phase === "leaving") && <><Icon name="check" size={16} sw={2.6} className="check-draw" /> Unlocked</>}
          {phase === "idle" && <ShinyText text="Unlock" color="var(--bg)" shineColor="var(--accent)" speed={2.4} delay={1.2} />}
        </button>

        <div className="login-foot">
          <span>Scans run on GitHub Actions</span>
          <span>Prices from Yahoo Finance</span>
        </div>
      </form>
    </main>
  );
}
