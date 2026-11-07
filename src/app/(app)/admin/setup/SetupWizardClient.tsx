'use client';

import { useState, useTransition } from 'react';
import {
  Container,
  Title,
  Text,
  Stepper,
  Paper,
  Group,
  Badge,
  Button,
  Stack,
  Alert,
  ThemeIcon,
  Anchor,
  SimpleGrid,
} from '@mantine/core';
import {
  IconReceipt,
  IconFileText,
  IconList,
  IconCategory,
  IconUsers,
  IconLink,
  IconCheck,
  IconRocket,
  IconConfetti,
  IconRefresh,
  IconTag,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { runAction } from '@/lib/run-action';
import { addedStandardCodes } from '@/lib/ui/indirect-seed-copy';
import { getSetupAccessGaps, getSetupStatus } from '@/server/actions/setup';
import type { SetupAccessGaps, SetupStatus, SetupStepKey } from '@/server/internal/setup';
import { seedIndirectCodes } from '@/server/actions/indirect-codes';
import { autobridgeChargeCodesFromClins } from '@/server/actions/charge-codes';
import classes from './Setup.module.css';
import { WriteButton } from '@/components/shell/WorkspaceMode';

interface Props {
  initialStatus: SetupStatus;
  /** C17: who still has no direct charge code (getSetupAccessGaps). */
  initialGaps?: SetupAccessGaps;
}

type CountKey = keyof Omit<SetupStatus, 'isComplete' | 'steps' | 'done' | 'total'>;

interface StepConfig {
  key: SetupStepKey;
  countKey: CountKey;
  title: string;
  description: string;
  helpText: (status: SetupStatus) => string;
  icon: React.ReactNode;
  required: boolean;
  linkHref: string;
  linkLabel: string;
  secondaryLinkHref?: string;
  secondaryLinkLabel?: string;
  entityLabel: string; // e.g., "contracts", "employees"
}

/** feature-plan-ux-navigation-home.md §4.7 (UX-AUDIT B1): the steps that actually make a timesheet usable, in order. */
export const STEPS: StepConfig[] = [
  {
    key: 'indirectCodes',
    countKey: 'indirectCodes',
    title: 'Indirect charge codes',
    description: 'Leave, overhead and G&A codes for total time accounting.',
    helpText: () => 'These codes let employees record time like PTO, holidays, overhead and training. "Seed default DCAA codes" creates the 9 standard codes.',
    icon: <IconReceipt size={18} />,
    required: false,
    linkHref: '/admin/charge-codes?tab=indirect',
    linkLabel: 'Go to indirect codes',
    entityLabel: 'indirect codes',
  },
  {
    key: 'contracts',
    countKey: 'contracts',
    title: 'Contracts',
    description: 'Create your contract structure.',
    helpText: () => 'Each contract needs a contract number and name. You can add funded value, ceiling value and dates.',
    icon: <IconFileText size={18} />,
    required: true,
    linkHref: '/admin/contracts',
    linkLabel: 'Go to contracts and CLINs',
    entityLabel: 'contracts',
  },
  {
    key: 'clins',
    countKey: 'clins',
    title: 'CLINs',
    description: 'Add line items under your contracts.',
    helpText: () => 'CLINs are the line items of a contract; hours roll up to them through charge codes. Each contract needs at least one. Add them from the Contracts and CLINs page.',
    icon: <IconList size={18} />,
    required: true,
    linkHref: '/admin/contracts',
    linkLabel: 'Go to contracts and CLINs',
    entityLabel: 'CLINs',
  },
  {
    key: 'chargeCodes',
    countKey: 'chargeCodes',
    title: 'Charge codes',
    description: 'Charge codes are what employees log time against. Each one belongs to a CLIN.',
    helpText: () => 'Charge codes are what employees log time against. Each one belongs to a CLIN. Create your own, or create one per active CLIN in one step.',
    icon: <IconTag size={18} />,
    required: true,
    linkHref: '/admin/charge-codes',
    linkLabel: 'Go to charge codes',
    entityLabel: 'charge codes',
  },
  {
    key: 'laborCategories',
    countKey: 'laborCategories',
    title: 'Labor categories',
    description: 'Define hourly rates per CLIN.',
    helpText: () => 'Labor categories define the roles and hourly rates for each CLIN, for example Senior Engineer at $145/hr. Costs use them.',
    icon: <IconCategory size={18} />,
    required: false,
    linkHref: '/admin/labor-categories',
    linkLabel: 'Go to labor categories',
    entityLabel: 'labor categories',
  },
  {
    key: 'employees',
    countKey: 'employees',
    title: 'Employees',
    description: 'Add the people who will record time.',
    helpText: () => 'Create an account for everyone who will record time: name, email and role (employee, supervisor or admin).',
    icon: <IconUsers size={18} />,
    required: true,
    linkHref: '/admin/users',
    linkLabel: 'Go to users',
    secondaryLinkHref: '/settings/import',
    secondaryLinkLabel: 'Or use Data import (people only)',
    entityLabel: 'employees',
  },
  {
    key: 'chargeCodeAccess',
    countKey: 'employeesWithAccess',
    title: 'Charge code access',
    description: 'Give each employee the charge codes they may use.',
    helpText: (st) => `Give each employee the charge codes they may use. ${st.employeesWithAccess} of ${st.employees} employees have at least one.`,
    icon: <IconLink size={18} />,
    required: true,
    linkHref: '/admin/assignments',
    linkLabel: 'Go to assignments',
    entityLabel: 'employees with access',
  },
];

export type StepState = 'done' | 'partial' | 'todo';

/**
 * A step's state (feature-plan-ux-page-fixes.md C17), the ONE rule used by the Stepper, the step panel and the summary
 * grid: charge code access is "partial" when some, but not all, employees and supervisors have a chargeable code.
 */
export function stepState(status: SetupStatus, key: SetupStepKey): StepState {
  const step = STEPS.find((s) => s.key === key)!;
  if (status[step.countKey] === 0) return 'todo';
  if (key === 'chargeCodeAccess' && status.steps.find((s) => s.key === key)?.allCovered === false) return 'partial';
  return 'done';
}

/** The step to open: the first required step not done, then the first recommended one, then a partial one; else past the end. */
export function firstIncompleteStep(status: SetupStatus): number {
  const states = STEPS.map((s) => stepState(status, s.key));
  const first = (match: (i: number) => boolean) => STEPS.findIndex((_, i) => match(i));
  for (const match of [
    (i: number) => STEPS[i].required && states[i] === 'todo',
    (i: number) => !STEPS[i].required && states[i] === 'todo',
    (i: number) => states[i] === 'partial',
  ]) {
    const i = first(match);
    if (i >= 0) return i;
  }
  return STEPS.length;
}

const accessOf = (status: SetupStatus) => {
  const step = status.steps.find((s) => s.key === 'chargeCodeAccess');
  return { withAccess: step?.withAccess ?? status.employeesWithAccess, total: step?.total ?? status.employees };
};

export function SetupWizardClient({ initialStatus, initialGaps = { missingCount: 0, names: [] } }: Props) {
  const [status, setStatus] = useState<SetupStatus>(initialStatus);
  const [gaps, setGaps] = useState<SetupAccessGaps>(initialGaps);
  const [isPending, startTransition] = useTransition();
  const [seedingIndirect, setSeedingIndirect] = useState(false);
  const [bridging, setBridging] = useState(false);

  const [activeStep, setActiveStep] = useState(() => firstIncompleteStep(initialStatus));

  // C17: the reads aren't ActionResults, so try/catch. The status and the gaps are refetched together, so the names
  // always match the counts; the wizard then opens the next incomplete step.
  function refreshStatus() {
    startTransition(async () => {
      try {
        const [updated, updatedGaps] = await Promise.all([getSetupStatus(), getSetupAccessGaps()]);
        setStatus(updated);
        setGaps(updatedGaps);
        setActiveStep(firstIncompleteStep(updated));
      } catch {
        notifications.show({ title: 'Refresh failed', message: "Couldn't refresh setup status.", color: 'red' });
      }
    });
  }

  async function handleSeedIndirect() {
    setSeedingIndirect(true);
    const result = await runAction(seedIndirectCodes(), { errorTitle: 'Couldn’t create indirect codes' });
    setSeedingIndirect(false);
    if (!result.ok) return;
    // C3: honest about what happened — nothing is added to a workspace that already has codes.
    notifications.show(result.data.created > 0
      ? { title: 'Standard codes added', message: addedStandardCodes(result.data.created), color: 'success' }
      : {
        title: 'No codes added',
        message: 'Your workspace already has indirect codes, so none were added. Reactivate them, and turn on Show on every timesheet, on the Indirect codes page.',
        color: 'gray',
      });
    refreshStatus();
  }

  async function handleAutobridge() {
    setBridging(true);
    const result = await runAction(autobridgeChargeCodesFromClins(), { errorTitle: 'Couldn’t create charge codes' });
    setBridging(false);
    if (!result.ok) return;
    // feature-plan-ux-people-codes.md §3.3: the rows actually inserted (a CLIN taken meanwhile is skipped, not counted).
    notifications.show({ title: 'Charge codes created', message: `Created ${result.data.created} charge ${result.data.created === 1 ? 'code' : 'codes'}`, color: 'success' });
    refreshStatus();
  }

  const access = accessOf(status);
  const stillNeed = `${access.total - access.withAccess} of ${access.total} employees still need a charge code.`;
  const accessPartial = stepState(status, 'chargeCodeAccess') === 'partial';

  // All done state
  if (status.isComplete) {
    const allDone = STEPS.every((s) => stepState(status, s.key) === 'done');
    const k = gaps.missingCount;

    return (
      <Container size="md" py="xl">
        <Paper p="xl" radius="md" withBorder>
          <Stack align="center" gap="lg">
            <ThemeIcon size={80} radius="xl" color="success" variant="light">
              <IconConfetti size={40} />
            </ThemeIcon>
            <Title order={1} size="h2">Setup complete</Title>
            <Text c="dimmed" ta="center" maw={500}>
              {allDone
                ? `All ${STEPS.length} setup steps are done. Your team can start recording time.`
                : 'The required steps are done, so your team can start recording time. The recommended steps below are still worth doing.'}
            </Text>

            {accessPartial && k > 0 && (
              <Alert color="warning" variant="light" maw={500} data-testid="setup-access-gaps">
                <Text size="sm">
                  {k} {k === 1 ? 'employee has' : 'employees have'} no direct charge code yet and will see only indirect and leave rows: {gaps.names.join(', ')}
                  {k > gaps.names.length ? ` and ${k - gaps.names.length} more` : ''}.
                </Text>
                <Anchor href="/admin/assignments" size="sm">Assign charge codes</Anchor>
              </Alert>
            )}

            {STEPS.some((s) => !s.required && stepState(status, s.key) === 'todo') && (
              <Alert color="warning" variant="light" title="Recommended steps remaining" maw={500}>
                {STEPS.filter((s) => !s.required && status[s.countKey] === 0).map((s) => (
                  <Text key={s.key} size="sm">
                    • {s.title} — <Anchor href={s.linkHref} size="sm">{s.linkLabel}</Anchor>
                  </Text>
                ))}
              </Alert>
            )}

            <Group>
              <Button component="a" href="/home" variant="filled">
                Go to Home
              </Button>
              <Button component="a" href="/timesheet" variant="light">
                Open timesheet
              </Button>
            </Group>
          </Stack>
        </Paper>

        {/* Summary stats */}
        <Paper p="md" radius="md" withBorder mt="lg">
          <Title order={2} size="h4" mb="sm">Setup Summary</Title>
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="sm">
            {STEPS.map((step) => {
              const state = stepState(status, step.key);
              return (
                <Paper key={step.key} data-step={step.key} data-state={state} p="sm" radius="sm" withBorder style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', minHeight: 90 }}>
                  {state === 'done' ? (
                    <ThemeIcon size="md" color="success" variant="light" radius="xl" mb={6}>
                      <IconCheck size={14} />
                    </ThemeIcon>
                  ) : state === 'partial' ? (
                    <ThemeIcon size="md" color="warning" variant="light" radius="xl" mb={6}>
                      <IconAlertTriangle size={14} />
                    </ThemeIcon>
                  ) : (
                    <Badge size="xs" color="warning" variant="light" mb={6}>Pending</Badge>
                  )}
                  <Text size="sm" fw={500} lh={1.2}>{step.title}</Text>
                  <Text size="xs" c="dimmed" mt={4}>
                    {state === 'partial' ? stillNeed : `${status[step.countKey]} ${step.entityLabel}`}
                  </Text>
                </Paper>
              );
            })}
          </SimpleGrid>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="signal" variant="light" radius="md">
              <IconRocket size={20} />
            </ThemeIcon>
            <Title order={1} size="h2">Setup Wizard</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Complete these steps to get your CadenzPoint workspace ready for your team.
          </Text>
        </div>
        <Button
          variant="subtle"
          size="sm"
          leftSection={<IconRefresh size={14} />}
          onClick={refreshStatus}
          loading={isPending}
        >
          Refresh status
        </Button>
      </Group>

      <Stepper
        active={activeStep}
        onStepClick={setActiveStep}
        orientation="vertical"
        size="sm"
        classNames={{ stepIcon: classes.stepIcon }}
      >
        {STEPS.map((step, index) => {
          // C17: Mantine marks every step before `active` completed and every step after it inactive, so each step's
          // own state is carried by its icon, color and (always) its description.
          const state = stepState(status, step.key);
          return (
          <Stepper.Step
            key={step.key}
            label={step.title}
            description={state === 'done'
              ? `Done · ${status[step.countKey]} ${step.entityLabel}`
              : state === 'partial'
                ? `${access.withAccess} of ${access.total} employees have a charge code`
                : `Not done · ${step.description}`}
            icon={step.icon}
            completedIcon={state === 'done' ? <IconCheck size={16} /> : step.icon}
            color={state === 'done' ? 'success' : state === 'partial' ? 'warning' : 'gray'}
            data-state={state}
            loading={isPending && activeStep === index}
          >
            <Paper p="md" radius="md" withBorder ml="sm" mb="md">
              <Group justify="space-between" mb="sm">
                <Text fw={600}>{step.title}</Text>
                <Badge
                  color={state === 'done' ? 'success' : state === 'partial' ? 'warning' : step.required ? 'red' : 'warning'}
                  variant="light"
                  size="sm"
                >
                  {state === 'done' ? 'Done' : state === 'partial' ? 'Partly done' : step.required ? 'Required' : 'Recommended'}
                </Badge>
              </Group>

              <Text size="sm" c="dimmed" mb="md">
                {step.helpText(status)}
              </Text>

              {state === 'done' ? (
                <Alert color="success" variant="light" mb="sm">
                  <Text size="sm">
                    ✅ {status[step.countKey]} {step.entityLabel} created
                  </Text>
                </Alert>
              ) : state === 'partial' ? (
                <Alert color="warning" variant="light" mb="sm">
                  <Text size="sm">{stillNeed}</Text>
                </Alert>
              ) : (
                <Alert color={step.required ? 'red' : 'warning'} variant="light" mb="sm">
                  <Text size="sm">
                    No {step.entityLabel} yet
                  </Text>
                </Alert>
              )}

              <Group gap="sm">
                {step.key === 'chargeCodes' && (
                  <WriteButton variant="light" size="sm" onClick={handleAutobridge} loading={bridging}>
                    Create one per CLIN
                  </WriteButton>
                )}

                {/* Special: Seed Default Codes button for indirect codes step */}
                {step.key === 'indirectCodes' && status.indirectCodes === 0 && (
                  <WriteButton
                    variant="filled"
                    size="sm"
                    onClick={handleSeedIndirect}
                    loading={seedingIndirect}
                  >
                    Seed default DCAA codes
                  </WriteButton>
                )}

                <Button
                  component="a"
                  href={step.linkHref}
                  variant={step.key === 'indirectCodes' && status.indirectCodes === 0 ? 'light' : 'filled'}
                  size="sm"
                >
                  {step.linkLabel} →
                </Button>

                {step.secondaryLinkHref && (
                  <Button
                    component="a"
                    href={step.secondaryLinkHref}
                    variant="subtle"
                    size="sm"
                  >
                    {step.secondaryLinkLabel}
                  </Button>
                )}
              </Group>
            </Paper>
          </Stepper.Step>
          );
        })}
      </Stepper>
    </Container>
  );
}
