import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { submissionTypes } from "@shared/schema";
import { Save, DollarSign, Clock, Shield, ToggleLeft, ToggleRight } from "lucide-react";

interface ServiceTierRow {
  id: number;
  service_type: string;
  name: string;
  tier_id: string;
  price_per_card: number;
  turnaround_days: number;
  max_value_gbp: number;
  features: string[];
  is_active: boolean;
  sort_order: number;
}

export default function AdminPricing() {
  const [activeService, setActiveService] = useState("grading");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{
    pricePerCard: string;
    turnaroundDays: string;
    maxValueGbp: string;
    isActive: boolean;
  }>({ pricePerCard: "", turnaroundDays: "", maxValueGbp: "", isActive: true });

  const { data: allTiers = [], isLoading } = useQuery<ServiceTierRow[]>({
    queryKey: ["/api/admin/service-tiers"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      await apiRequest("PUT", `/api/admin/service-tiers/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/service-tiers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-tiers"] });
      setEditingId(null);
    },
  });

  const tiers = allTiers.filter(t => t.service_type === activeService);

  const startEdit = (tier: ServiceTierRow) => {
    setEditingId(tier.id);
    setEditForm({
      pricePerCard: String(tier.price_per_card),
      turnaroundDays: String(tier.turnaround_days),
      maxValueGbp: String(tier.max_value_gbp),
      isActive: tier.is_active,
    });
  };

  const handleSave = () => {
    if (editingId === null) return;
    updateMutation.mutate({
      id: editingId,
      data: {
        pricePerCard: parseInt(editForm.pricePerCard, 10),
        turnaroundDays: parseInt(editForm.turnaroundDays, 10),
        maxValueGbp: parseInt(editForm.maxValueGbp, 10),
        isActive: editForm.isActive,
      },
    });
  };

  const serviceTypes = submissionTypes;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest" data-testid="text-pricing-title">
          PRICING MANAGEMENT
        </h1>
        <p className="text-[#999999] text-sm">Edit service tier pricing, turnaround, and max values per service type</p>
      </div>

      <div className="flex gap-2 mb-6">
        {serviceTypes.map((st) => (
          <button
            key={st.id}
            onClick={() => { setActiveService(st.id); setEditingId(null); }}
            className={`text-sm px-4 py-2 rounded border transition-colors tracking-wider font-medium ${
              activeService === st.id
                ? "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                : "text-[#999999] border-[#E8E4DC] hover:text-[#1A1A1A]"
            }`}
            data-testid={`button-service-${st.id}`}
          >
            {st.name}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 bg-[#D4AF37]/5 rounded" />)}
        </div>
      ) : tiers.length === 0 ? (
        <div className="text-center py-12 border border-[#D4AF37]/10 rounded-lg">
          <p className="text-[#999999]">No tiers found for {activeService}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tiers.map((tier) => (
            <div
              key={tier.id}
              className={`border rounded-lg p-4 transition-colors ${
                !tier.is_active ? "border-[#E8E4DC] opacity-60" : "border-[#D4AF37]/20"
              }`}
              data-testid={`pricing-tier-${tier.tier_id}`}
            >
              {editingId === tier.id ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[#D4AF37] font-bold text-lg tracking-wider">{tier.name}</h3>
                    <span className="text-[#999999] text-xs font-mono">{tier.service_type} / {tier.tier_id}</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="text-[#666666] text-xs block mb-1">
                        <DollarSign size={10} className="inline" /> Price (pence)
                      </label>
                      <input
                        type="number"
                        value={editForm.pricePerCard}
                        onChange={(e) => setEditForm({ ...editForm, pricePerCard: e.target.value })}
                        className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]"
                        data-testid="input-edit-price"
                      />
                      <p className="text-gray-600 text-xs mt-0.5">
                        = £{(parseInt(editForm.pricePerCard, 10) / 100 || 0).toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <label className="text-[#666666] text-xs block mb-1">
                        <Clock size={10} className="inline" /> Turnaround (days)
                      </label>
                      <input
                        type="number"
                        value={editForm.turnaroundDays}
                        onChange={(e) => setEditForm({ ...editForm, turnaroundDays: e.target.value })}
                        className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]"
                        data-testid="input-edit-turnaround"
                      />
                    </div>
                    <div>
                      <label className="text-[#666666] text-xs block mb-1">
                        <Shield size={10} className="inline" /> Max Value (£)
                      </label>
                      <input
                        type="number"
                        value={editForm.maxValueGbp}
                        onChange={(e) => setEditForm({ ...editForm, maxValueGbp: e.target.value })}
                        className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-[#1A1A1A] text-sm focus:outline-none focus:border-[#D4AF37]"
                        data-testid="input-edit-maxvalue"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setEditForm({ ...editForm, isActive: !editForm.isActive })}
                      className={`flex items-center gap-1.5 text-sm ${editForm.isActive ? "text-emerald-500" : "text-[#999999]"}`}
                      data-testid="button-toggle-active"
                    >
                      {editForm.isActive ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      {editForm.isActive ? "Active" : "Inactive"}
                    </button>
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleSave}
                      disabled={updateMutation.isPending}
                      className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[#D4AF37]/20 disabled:opacity-50 flex items-center gap-1.5"
                      data-testid="button-save-tier"
                    >
                      <Save size={14} /> {updateMutation.isPending ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-[#666666] hover:text-[#1A1A1A] text-sm px-4 py-2 rounded border border-[#E8E4DC] hover:border-[#D4AF37]/40 transition-colors"
                      data-testid="button-cancel-edit"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => startEdit(tier)}
                  className="w-full text-left"
                  data-testid={`button-edit-tier-${tier.tier_id}`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[#D4AF37] font-bold text-lg tracking-wider">{tier.name}</h3>
                        {!tier.is_active && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-[#E8E4DC] text-[#999999]">Inactive</span>
                        )}
                      </div>
                      <p className="text-[#666666] text-sm mt-1">
                        {tier.turnaround_days} working days · Max value: £{tier.max_value_gbp.toLocaleString()}
                      </p>
                    </div>
                    <span className="text-[#1A1A1A] font-bold text-lg">
                      £{(tier.price_per_card / 100).toFixed(tier.price_per_card % 100 === 0 ? 0 : 2)} per card
                    </span>
                  </div>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 border border-[#D4AF37]/10 rounded-lg p-4">
        <p className="text-[#999999] text-xs">
          Changes take effect immediately for new submissions. Existing submissions retain their original pricing.
          Editing one service type does not affect other service types.
        </p>
      </div>
    </div>
  );
}
