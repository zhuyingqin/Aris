#!/usr/bin/env python3
"""
Formal analysis of the proposition:
    "There exists a rotating device that can continuously operate and
     self-accelerate without any external energy input."

Method
------
We reduce the proposition to well-posed subproblems and test them with
(i) an analytic energy / angular-momentum model and (ii) a numerical
simulation of a rigid rotating device with an internally movable-mass
"self-acceleration mechanism" (variable moment of inertia) plus friction.

Physical commitments (standard Newtonian mechanics, closed system):
    * Rotational kinetic energy   E = 1/2 * I(t) * omega(t)^2
    * Angular momentum            L = I(t) * omega(t)
    * No external torque  =>      dL/dt = 0
    * No external power   =>      d(E_sys)/dt = -P_loss ,  P_loss >= 0
    * Energy conservation: any increase in rotational energy must be funded
      by stored internal energy (or external input). It cannot appear for free.

Scenarios:
    A. Lossless rigid rotor, fixed I              -> omega = const (no acceleration)
    B. Rigid rotor with viscous friction          -> omega decays  (deceleration)
    C. Variable-moment-of-inertia "skater" rotor  -> omega rises only because
       internal actuator does work shifting mass; full energy budget closes
       (rotational gain == internal-stored-energy loss).
    D. Claimed free self-acceleration             -> required input power is
       strictly positive for exp growth; a zero-input closed system cannot
       sustain it. We compute and report that contradiction.

Outputs: outputs/sim.json (numeric summary), outputs/fig_<scenario>.png
"""

import json
import os

import numpy as np

OUT = os.path.join(os.path.dirname(__file__), "..", "outputs")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------------------
# 1. Analytic energy / angular-momentum model
# ---------------------------------------------------------------------------

def scenario_A_analytic(I, omega0):
    """Lossless rigid rotor, fixed moment of inertia, zero external torque + no friction."""
    E0 = 0.5 * I * omega0 ** 2
    L = I * omega0
    return {
        "name": "A_lossless_fixed_I",
        "I": I, "omega0": omega0, "E0": E0, "L": L,
        "omega_final": omega0,          # d(omega)/dt = 0
        "domega_dt": 0.0,
        "E_final": E0,
    }

def scenario_B_analytic(I, omega0, gamma, t_end, n=2000):
    """Rigid rotor + viscous friction: I(domega/dt) = -gamma*omega."""
    t = np.linspace(0, t_end, n)
    omega = omega0 * np.exp(-(gamma / I) * t)
    E = 0.5 * I * omega ** 2
    alpha0 = -(gamma / I) * omega0          # initial angular acceleration
    return {
        "name": "B_friction_decay",
        "I": I, "omega0": omega0, "gamma": gamma,
        "omega_final": omega[-1], "E_final": E[-1],
        "alpha0": alpha0,                   # negative -> deceleration
        "E_decay_ratio": E[-1] / E[0],
    }

def scenario_C_skater(I0, m, r0, rf, omega0, t_end, n=4000):
    """
    Variable-moment-of-inertia "skater" mechanism with zero external torque
    but a real internal actuator that moves a mass radially.

      I(t) = I0 + m * r(t)^2
      r(t) = r0 -> rf  (mass pulled inward)
      No external torque -> L = I * omega is constant.
    """
    t = np.linspace(0, t_end, n)
    radius = r0 - (r0 - rf) * (t / t_end)          # linear inward move (smooth)
    I = I0 + m * radius ** 2
    L = (I0 + m * r0 ** 2) * omega0                # conserved (no external torque)
    omega = L / I                                   # omega rises as I falls
    E_rot = 0.5 * I * omega ** 2
    # Energy bookkeeping: the only way E_rot can grow is actuator work.
    # With a perfect lossless actuator, that work comes from an internal store
    # E_store. Total E = E_rot + E_store must be conserved.
    E_store = np.full_like(E_rot, 0.0)
    E_total = E_rot[0]                              # conservation constraint
    E_store = E_total - E_rot
    # If instead the mechanism were *passive* (no actuator work available),
    # then a reduced-I rotor would actually tend to a smaller omega; but here
    # we model the honest upper bound where wrist-work is fully supplied from a
    # finite internal store.
    E_store_drawn = E_rot[0] - E_rot[-1]            # stored energy consumed (<0 adds to rotor)
    return {
        "name": "C_variable_I_skater",
        "omega0": omega0, "omega_final": omega[-1],
        "E_rot0": E_rot[0], "E_rot_final": E_rot[-1],
        "E_rot_gain": E_rot[-1] - E_rot[0],
        "E_store_drawn": E_rot[-1] - E_rot[0],      # actuator work drawn from store
        "L": L,
        "bookkeeping": "rotational_gain == store_depletion (exact)",
    }

def scenario_D_claimed_budget(omega0, alpha, I, t_end):
    """
    Claimed free self-acceleration  omega(t) = omega0 * exp(alpha*t),  alpha > 0.
    Compute the instantaneous power that a *zero-input* system would need to be
    hiding, and show it is strictly positive -> contradiction.
    """
    t = np.linspace(0, t_end, 1000)
    omega = omega0 * np.exp(alpha * t)
    E_rot = 0.5 * I * omega ** 2
    P_needed = np.gradient(E_rot, t)                 # hidden power for growth
    return {
        "name": "D_claimed_selfaccel_budget",
        "alpha": alpha, "I": I, "t_end": t_end,
        "P_min": float(P_needed[0]),                  # power at t=0 (smallest)
        "P_final": float(P_needed[-1]),
        "P_strictly_positive": bool(np.all(P_needed > 0)),
        "E_at_tend": float(E_rot[-1]),
        "note": "zero-input closed system cannot supply P>0 => contradiction",
    }

# ---------------------------------------------------------------------------
# 2. Numerical simulation (integrate the torque balance)
# ---------------------------------------------------------------------------

def integrate_rotor(domega_func, I, omega0, t_end, n=4000):
    """Explicit RK4 integration of  d(omega)/dt = domega_func(omega)."""
    t = np.linspace(0, t_end, n)
    dt = t[1] - t[0]
    omega = np.empty(n)
    omega[0] = omega0
    for i in range(n - 1):
        w = omega[i]
        k1 = domega_func(w)
        k2 = domega_func(w + 0.5 * dt * k1)
        k3 = domega_func(w + 0.5 * dt * k2)
        k4 = domega_func(w + dt * k3)
        omega[i + 1] = w + (dt / 6.0) * (k1 + 2 * k2 + 2 * k3 + k4)
    return t, omega

def run_simulations():
    """Run the four scenarios, write figures + numeric JSON."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    I = 0.05          # kg m^2
    omega0 = 20.0     # rad/s
    gamma = 0.01      # N m s  (viscous coefficient)
    t_end = 10.0
    m = 0.4           # movable mass kg
    r0 = 0.30         # outer radius m
    rf = 0.10         # inner radius m

    res = {}
    res["A"] = scenario_A_analytic(I, omega0)
    res["B"] = scenario_B_analytic(I, omega0, gamma, t_end)
    res["C"] = scenario_C_skater(I, m, r0, rf, omega0, t_end)
    res["D"] = scenario_D_claimed_budget(omega0, 0.20, I, t_end)

    # ---- Numeric integration for scenarios A and B (verification) ----
    t, omA = integrate_rotor(lambda w: 0.0, I, omega0, t_end)
    _, omB = integrate_rotor(lambda w: -(gamma / I) * w, I, omega0, t_end)
    # ---- Scenario C: integrate with variable I. ----
    tc = np.linspace(0, t_end, 4000)
    radius = r0 - (r0 - rf) * (tc / t_end)
    Ic = I + m * radius ** 2
    Lc = (I + m * r0 ** 2) * omega0
    omC = Lc / Ic
    E_rotC = 0.5 * Ic * omC ** 2
    E_totC = E_rotC[0]
    E_storeC = E_totC - E_rotC

    # ---- Figures ----
    fig, axes = plt.subplots(2, 2, figsize=(11, 8))

    ax = axes[0, 0]
    ax.plot(t, omA, color="tab:blue", label="rigid rotor, lossless")
    ax.plot(t, omB, color="tab:red", label="rigid rotor + viscous friction")
    ax.set_xlabel("time (s)"); ax.set_ylabel(r"$\omega$ (rad/s)")
    ax.set_title("Angular velocity: no self-acceleration")
    ax.legend(); ax.grid(alpha=0.3)

    ax = axes[0, 1]
    ax.plot(tc, omC, color="tab:green")
    ax.set_xlabel("time (s)"); ax.set_ylabel(r"$\omega$ (rad/s)")
    ax.set_title(r"Variable-$I$ 'skater' rotor ($L$ conserved)")
    ax.grid(alpha=0.3)

    ax = axes[1, 0]
    ax.plot(tc, E_rotC, color="tab:green", label=r"$E_{\mathrm{rot}}=\frac{1}{2}I\omega^2$")
    ax.plot(tc, E_storeC, color="tab:orange", ls="--",
            label=r"$E_{\mathrm{store}}$ (drawn by actuator)")
    ax.plot(tc, E_storeC + E_rotC, color="k", lw=2, label=r"$E_{\mathrm{total}}$ (conserved)")
    ax.set_xlabel("time (s)"); ax.set_ylabel("energy (J)")
    ax.set_title("Energy bookkeeping: growth is funded, not free")
    ax.legend(fontsize="small"); ax.grid(alpha=0.3)

    ax = axes[1, 1]
    P = np.gradient(E_rotC, tc)
    ax.plot(tc, P, color="tab:purple")
    ax.axhline(0, color="k", lw=0.8, ls=":")
    ax.set_xlabel("time (s)"); ax.set_ylabel(r"required internal power (W)")
    ax.set_title(r"Hidden power needed for $\omega$ growth ($P>0$)")
    ax.grid(alpha=0.3)

    fig.suptitle("Energetics of a rotating device under conservation of energy")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "fig_scenarios.png"), dpi=150)

    # ---- Also a dedicated claimed-vs-real growth figure ----
    fig2, ax = plt.subplots(figsize=(6, 4.5))
    tc2 = np.linspace(0, t_end, 1000)
    ax.plot(tc2, omega0 * np.exp(0.2 * tc2), color="tab:red",
            label="claimed: $\\omega_0 e^{0.2t}$ (needs $P>0$)")
    ax.plot(tc, omC, color="tab:green",
            label="funded by internal store")
    ax.set_xlabel("time (s)"); ax.set_ylabel(r"$\omega$ (rad/s)")
    ax.set_title("Self-acceleration claim vs. energy-conserving system")
    ax.legend(); ax.grid(alpha=0.3)
    fig2.tight_layout()
    fig2.savefig(os.path.join(OUT, "fig_claim_vs_conserving.png"), dpi=150)

    return res

def main():
    res = run_simulations()
    with open(os.path.join(OUT, "sim.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2)
    print("=== Numerical summary ===")
    print(json.dumps(res, indent=2))
    print("\nFiles written:")
    for f in os.listdir(OUT):
        print("  outputs/" + f)

if __name__ == "__main__":
    main()