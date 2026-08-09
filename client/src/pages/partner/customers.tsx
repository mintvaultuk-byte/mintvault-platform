import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { partnerCustomers, partnerErrorMessage, type PartnerCustomer } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { Pencil, PlusCircle } from "lucide-react";

const EMPTY = { fullName: "", email: "", phone: "", reference: "" };

export default function PartnerCustomersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PartnerCustomer | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ["/api/partner/customers", search],
    queryFn: () => partnerCustomers.list(search || undefined),
  });

  function startCreate() {
    setEditing(null);
    setForm(EMPTY);
    setSaveError(null);
  }

  function startEdit(customer: PartnerCustomer) {
    setEditing(customer);
    setForm({
      fullName: customer.fullName,
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      reference: customer.reference ?? "",
    });
    setSaveError(null);
  }

  async function saveCustomer() {
    if (!form.fullName.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        fullName: form.fullName.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        reference: form.reference.trim() || null,
      };
      if (editing) await partnerCustomers.edit(editing.id, payload);
      else await partnerCustomers.create(payload);
      setForm(EMPTY);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["/api/partner/customers"] });
    } catch (err) {
      setSaveError(partnerErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="partner-customers-page">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Customers</h1>
          <p className="text-sm text-muted-foreground">Your shop customer book.</p>
        </div>
        <Button onClick={startCreate} data-testid="button-customer-create">
          <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
          New Customer
        </Button>
      </div>

      <Card>
        <CardContent className="p-4">
          <Label htmlFor="customer-page-search">Search</Label>
          <Input
            id="customer-page-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-customer-page-search"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editing ? "Edit customer" : "Create customer"}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" value={form.fullName} onChange={(fullName) => setForm({ ...form, fullName })} required />
          <Field label="Email" type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} />
          <Field label="Phone" type="tel" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
          <Field label="Reference" value={form.reference} onChange={(reference) => setForm({ ...form, reference })} />
          {saveError && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2" data-testid="text-customer-save-error">
              {saveError}
            </p>
          )}
          <div className="sm:col-span-2 flex gap-2">
            <Button
              onClick={saveCustomer}
              disabled={saving || !form.fullName.trim()}
              data-testid="button-customer-save"
            >
              {saving ? "Saving..." : editing ? "Save changes" : "Save customer"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={startCreate} data-testid="button-customer-cancel-edit">
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {customers.isLoading && <PartnerLoadingState label="Loading customers..." />}
      {customers.error && (
        <PartnerErrorState message={partnerErrorMessage(customers.error)} onRetry={() => customers.refetch()} />
      )}
      {customers.data && (
        <div className="grid gap-2" data-testid="list-customers-page">
          {customers.data.map((customer) => (
            <Card key={customer.id} className="rounded-md">
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium truncate">{customer.fullName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[customer.reference, customer.email, customer.phone].filter(Boolean).join(" · ") ||
                      "No contact details"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${customer.fullName}`}
                  onClick={() => startEdit(customer)}
                  data-testid={`button-edit-customer-${customer.id}`}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  const id = `customer-field-${label.toLowerCase()}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
