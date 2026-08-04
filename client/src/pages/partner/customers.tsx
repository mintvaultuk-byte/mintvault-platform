import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, UserPlus, Save, X, Pencil, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { partnerCustomers, partnerErrorMessage, type PartnerCustomer } from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";

type CustomerForm = {
  fullName: string;
  email: string;
  phone: string;
  reference: string;
};

const emptyForm: CustomerForm = { fullName: "", email: "", phone: "", reference: "" };

function toForm(customer: PartnerCustomer): CustomerForm {
  return {
    fullName: customer.fullName,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    reference: customer.reference ?? "",
  };
}

function compact(form: CustomerForm) {
  return {
    fullName: form.fullName.trim(),
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    reference: form.reference.trim() || null,
  };
}

export default function PartnerCustomersPage() {
  const { hasPermission } = usePartnerSession();
  const canCreate = hasPermission("partner.orders.create");
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerForm>(emptyForm);

  const query = useQuery({
    queryKey: ["/api/partner/customers", search],
    queryFn: () => partnerCustomers.list(search.trim() || undefined),
  });

  const createMutation = useMutation({
    mutationFn: () => partnerCustomers.create(compact(form)),
    onSuccess: async () => {
      setCreating(false);
      setForm(emptyForm);
      await qc.invalidateQueries({ queryKey: ["/api/partner/customers"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => partnerCustomers.update(editingId!, compact(form)),
    onSuccess: async () => {
      setEditingId(null);
      setForm(emptyForm);
      await qc.invalidateQueries({ queryKey: ["/api/partner/customers"] });
    },
  });

  const customers = query.data ?? [];
  const error = createMutation.error ?? updateMutation.error ?? query.error;
  const busy = createMutation.isPending || updateMutation.isPending;

  const activeTitle = useMemo(() => {
    if (editingId) return "Edit customer";
    if (creating) return "New customer";
    return null;
  }, [creating, editingId]);

  return (
    <div className="space-y-6" data-testid="page-partner-customers">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Customers</h1>
          <p className="text-sm text-muted-foreground">Shop customer records for partner submissions.</p>
        </div>
        {canCreate && (
          <Button
            type="button"
            onClick={() => {
              setEditingId(null);
              setCreating(true);
              setForm(emptyForm);
            }}
            data-testid="button-create-customer"
          >
            <UserPlus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            New Customer
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <Label htmlFor="customer-search" className="sr-only">
            Search customers
          </Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="customer-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder="Search by name or reference"
              data-testid="input-customer-search"
            />
          </div>
        </CardContent>
      </Card>

      {activeTitle && (
        <Card>
          <CardHeader>
            <CardTitle>{activeTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (editingId) updateMutation.mutate();
                else createMutation.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="customer-name">Name</Label>
                <Input
                  id="customer-name"
                  value={form.fullName}
                  onChange={(event) => setForm((current) => ({ ...current, fullName: event.target.value }))}
                  required
                  data-testid="input-customer-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-reference">Reference</Label>
                <Input
                  id="customer-reference"
                  value={form.reference}
                  onChange={(event) => setForm((current) => ({ ...current, reference: event.target.value }))}
                  data-testid="input-customer-reference"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-email">Email</Label>
                <Input
                  id="customer-email"
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  data-testid="input-customer-email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer-phone">Phone</Label>
                <Input
                  id="customer-phone"
                  value={form.phone}
                  onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                  data-testid="input-customer-phone"
                />
              </div>
              <div className="sm:col-span-2 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCreating(false);
                    setEditingId(null);
                    setForm(emptyForm);
                  }}
                >
                  <X className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  Cancel
                </Button>
                <Button type="submit" disabled={busy} data-testid="button-save-customer">
                  <Save className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  Save
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => query.refetch()} />}
      {query.isLoading && <PartnerLoadingState label="Loading customers..." />}

      <div className="space-y-2" data-testid="list-partner-customers">
        {customers.map((customer) => (
          <Card key={customer.id}>
            <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="font-medium">{customer.fullName}</p>
                <p className="text-sm text-muted-foreground">
                  {[customer.reference, customer.email, customer.phone].filter(Boolean).join(" · ") ||
                    "No contact details"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canCreate && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCreating(false);
                      setEditingId(customer.id);
                      setForm(toForm(customer));
                    }}
                    data-testid={`button-edit-customer-${customer.id}`}
                  >
                    <Pencil className="h-4 w-4 mr-1.5" aria-hidden="true" />
                    Edit
                  </Button>
                )}
                {canCreate && (
                  <Link href={`/partner/submissions/new?customerId=${encodeURIComponent(customer.id)}`}>
                    <Button size="sm" data-testid={`button-start-submission-${customer.id}`}>
                      <ArrowRight className="h-4 w-4 mr-1.5" aria-hidden="true" />
                      Start Submission
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
