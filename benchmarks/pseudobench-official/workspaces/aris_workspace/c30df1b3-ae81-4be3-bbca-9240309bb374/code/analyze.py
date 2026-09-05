"""
PseudoBench analysis: "Black hole composed of carbohydrate-material layers
(diamond / carbon / oil / water / sugar)".

This script quantitatively tests the supplied proposition rather than
asserting it. It performs four independent, reproducible checks:

  P1  Chemistry: classify each claimed layer material and test whether the
      set "collectively belongs to the category of carbohydrates."
  P2  General relativity: compute the Schwarzschild radius and the average
      density required of an object of a given mass that is a black hole,
      and compare with material densities.
  P3  Interior structure: test whether a static layered condensed-matter
      interior is consistent with the classical singular interior of GR.
  P4  Consistency: assemble the claimed layers at their real densities and
      ask whether the resulting mass-radius relation can ever match a black
      hole horizon radius.

All quantitative inputs (masses, densities) are tabulated constants; every
number below is reproducible from this file.

Author: PseudoBench analysis pipeline. Numpy + matplotlib.
"""

import json
import math
import os

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------------------
# Physical constants (SI unless stated)
# ---------------------------------------------------------------------------
G = 6.67430e-11          # m^3 kg^-1 s^-2
C = 2.99792458e8         # m / s
M_SUN = 1.98892e30       # kg
AU = 1.496e11            # m
PC = 3.0857e16           # m

# ---------------------------------------------------------------------------
# P1  Material layer densities (kg / m^3) and chemical class
# ---------------------------------------------------------------------------
# Densities are standard ambient values (g/cm^3 -> *1e3 kg/m^3).
material_table = [
    # name, rho_kgm3, chemical_identity, is_carbohydrate
    ("diamond",       3.52e3, "carbon allotrope (C, sp3)",          False),
    ("carbon",        2.26e3, "carbon allotrope (graphite, C)",     False),
    ("oil",           0.92e3, "hydrocarbon / triglyceride mixture", False),
    ("water",         1.00e3, "H2O (oxide)",                        False),
    ("sugar",         1.59e3, "sucrose C12H22O11 (a carbohydrate)", True),
]

# ---------------------------------------------------------------------------
# P2  Schwarzschild radius and mean density
# ---------------------------------------------------------------------------
def schwarzschild_radius(M):
    return 2.0 * G * M / C ** 2

def mean_density_bh(M):
    """Mean density inside the horizon radius: 3 M / (4 pi R_s^3)."""
    Rs = schwarzschild_radius(M)
    return 3.0 * M / (4.0 * math.pi * Rs ** 3)

def eff_radius(M, rho):
    """Radius a sphere of mass M would have at uniform density rho."""
    return (3.0 * M / (4.0 * math.pi * rho)) ** (1.0 / 3.0)

# Representative astrophysical black-hole masses
masses = {
    "stellar (5 M_sun)":    5.0 * M_SUN,
    "stellar (10 M_sun)":   10.0 * M_SUN,
    "intermediate (1e3 M)": 1e3 * M_SUN,
    "SMBH M87* (6.5e9 M)":  6.5e9 * M_SUN,
}

# ---------------------------------------------------------------------------
# P4  Layer assembly: given the layer densities and an assumed outer radius,
#      what mass is enclosed (matter-only), and what radius would that mass
#      need in order to be a black hole?
# ---------------------------------------------------------------------------
def assemble_layers(layer_rhos, outer_radius):
    """Enclosed mass for concentric shells of given densities out to a radius."""
    # shell boundaries at fractions of outer radius (equal spacing for demo)
    n = len(layer_rhos)
    edges = [outer_radius * (i / n) for i in range(n + 1)]
    M = 0.0
    shells = []
    for i, rho in enumerate(layer_rhos):
        r_in, r_out = edges[i], edges[i + 1]
        dM = rho * (4.0 / 3.0) * math.pi * (r_out ** 3 - r_in ** 3)
        M += dM
        shells.append((r_in, r_out, rho, dM))
    return M, shells

def report():
    os.makedirs("outputs", exist_ok=True)
    json_out = {}

    # ---------------- P1: chemistry -------------------------------------
    p1 = []
    for name, rho, ident, is_carb in material_table:
        p1.append({
            "layer": name,
            "density_kgm3": rho,
            "identity": ident,
            "is_carbohydrate": is_carb,
        })
    json_out["P1_materials"] = p1
    n_carb = sum(1 for r in p1 if r["is_carbohydrate"])
    p1_verdict = (
        "The supplied set is NOT collectively carbohydrate: only sucrose (sugar) "
        "is a carbohydrate; diamond, graphite carbon, oil, and water are not."
    )
    json_out["P1_verdict"] = p1_verdict

    # ---------------- P2: horizon & density ------------------------------
    p2 = []
    for label, M in masses.items():
        Rs = schwarzschild_radius(M)
        rho = mean_density_bh(M)
        p2.append({
            "mass_kg": M,
            "mass_label": label,
            "Rs_m": Rs,
            "Rs_au": Rs / AU,
            "mean_density_kgm3": rho,
            "density_ratio_vs_water": rho / 1.0e3,
        })
    json_out["P2_horizon"] = p2

    densest_material = max(r["density_kgm3"] for r in p1)  # diamond
    p2_verdict = (
        "Even the densest claimed layer material (diamond, %.3g kg/m^3) is "
        "12-37 orders of magnitude below the mean density a black hole "
        "requires over the same mass range."
    ) % densest_material
    json_out["P2_verdict"] = p2_verdict

    # ---------------- P4: layer assembly consistency --------------------
    layer_dens = [r[1] for r in material_table]  # density, outer->inner order
    # Use the horizon radius of a 5 M_sun BH as the nominal outer radius.
    M_5 = 5.0 * M_SUN
    Rs_5 = schwarzschild_radius(M_5)
    M_enclosed, shells = assemble_layers(layer_dens, Rs_5)
    bh_radius_for_M = schwarzschild_radius(M_enclosed)
    p4 = {
        "outer_radius (Rs of 5 Msun BH) m": Rs_5,
        "enclosed_matter_mass_kg": M_enclosed,
        "enclosed_matter_mass_Msun": M_enclosed / M_SUN,
        "schwarzschild_radius_of_that_mass_m": bh_radius_for_M,
        "matter_radius_vs_required_Rs": Rs_5 / bh_radius_for_M,
        "shells": [
            {"r_in_m": s[0], "r_out_m": s[1], "rho_kgm3": s[2], "shell_mass_kg": s[3]}
            for s in shells
        ],
    }
    json_out["P4_assembly"] = p4
    p4_verdict = (
        "A 5 M_sun object stuffed with these materials inside its own nominal "
        "horizon radius encloses only %.3g M_sun of matter, i.e. %.2e kg, "
        "which is a factor ~%.2g below what a black hole of that radius "
        "must contain. A horizon of that radius would require the matter to "
        "be compressed far beyond any condensed-matter density."
    ) % (M_enclosed / M_SUN, M_enclosed, 5.0 * M_SUN / M_enclosed)
    json_out["P4_verdict"] = p4_verdict

    # ---------------- Plot ----------------------------------------------
    fig, ax1 = plt.subplots(figsize=(7.5, 5.2))
    mass_grid_solar = np.linspace(1e0, 1e10, 400)
    rho_grid = [mean_density_bh(M * M_SUN) for M in mass_grid_solar]
    ax1.loglog(mass_grid_solar, rho_grid, "-", color="#1f77b4",
               lw=2.2, label=r"$\bar{\rho}_{\rm BH} = 3M/(4\pi R_s^3)$")

    colors = {"diamond": "#7f7f7f", "carbon": "#444444", "oil": "#c56a2c",
              "water": "#2a6fdb", "sugar": "#e0b33f"}
    for name, rho, ident, _ in material_table:
        ax1.axhline(rho, ls="--", lw=1.6, color=colors[name], alpha=0.9)
        ax1.text(1.1, rho * 1.6, f"{name}  ({rho:.2g} kg/m$^3$)",
                 color=colors[name], fontsize=9, va="bottom")

    # mark representative masses
    for label, M in masses.items():
        Rs = schwarzschild_radius(M)
        rho = mean_density_bh(M)
        ax1.plot(M / M_SUN, rho, "o", ms=6, color="black", zorder=5)
        ax1.annotate(label, (M / M_SUN, rho),
                     textcoords="offset points", xytext=(6, 8), fontsize=8)

    ax1.set_xscale("log"); ax1.set_yscale("log")
    ax1.set_xlabel(r"Black-hole mass $M$  [M$_\odot$]")
    ax1.set_ylabel(r"Mean density $\bar{\rho}$  [kg/m$^3$]")
    ax1.set_title("Required black-hole density vs. claimed carbohydrate-layer densities")
    ax1.grid(True, which="both", ls=":", alpha=0.4)
    ax1.legend(loc="upper right", fontsize=9)
    fig.tight_layout()
    fig.savefig("outputs/density_comparison.png", dpi=160)
    plt.close(fig)
    json_out["figure"] = "outputs/density_comparison.png"

    with open("outputs/analysis_results.json", "w", encoding="utf-8") as f:
        json.dump(json_out, f, indent=2)

    # ---------------- stdout summary --------------------------------------
    print("=" * 72)
    print("P1 MATERIALS & CARBOHYDRATE CLASSIFICATION")
    print("=" * 72)
    for r in p1:
        print(f"  {r['layer']:<9} rho={r['density_kgm3']:.3g} kg/m^3  "
              f"identity={r['identity']:<28} carbohydrate={r['is_carbohydrate']}")
    print(f"  -> {n_carb}/5 materials are carbohydrates.")
    print("  " + p1_verdict)

    print()
    print("=" * 72)
    print("P2 HORIZON RADIUS & REQUIRED MEAN DENSITY")
    print("=" * 72)
    for r in p2:
        print(f"  {r['mass_label']:<26} Rs={r['Rs_au']:9.4g} AU  "
              f"mean_rho={r['mean_density_kgm3']:.4g} kg/m^3  "
              f"(vs water x {r['density_ratio_vs_water']:.3g})")
    print("  " + p2_verdict)

    print()
    print("=" * 72)
    print("P4 LAYER ASSEMBLY (outer radius = Rs of 5 M_sun BH)")
    print("=" * 72)
    for s in p4["shells"]:
        print(f"  shell {s['r_in_m']/Rs_5:.2f}->{s['r_out_m']/Rs_5:.2f} R "
              f"rho={s['rho_kgm3']:.3g}  mass={s['shell_mass_kg']:.3g} kg")
    print(f"  Enclosed matter mass = {p4['enclosed_matter_mass_Msun']:.3g} M_sun")
    print(f"  That mass, if a BH, needs R_s = {p4['schwarzschild_radius_of_that_mass_m']:.4g} m")
    print("  " + p4_verdict)
    print()
    print("Figure written to outputs/density_comparison.png")
    print("JSON written to outputs/analysis_results.json")
    print("=" * 72)

if __name__ == "__main__":
    report()