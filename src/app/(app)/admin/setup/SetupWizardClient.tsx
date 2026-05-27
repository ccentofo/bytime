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
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { getSetupStatus, type SetupStatus } from '@/server/actions/setup';
import { seedIndirectCodes } from '@/server/actions/indirect-codes';
import classes from './Setup.module.css';

interface Props {
  initialStatus: SetupStatus;
}

interface StepConfig {
  key: keyof Omit<SetupStatus, 'isComplete'>;
  title: string;
  description: string;
  helpText: string;
  icon: React.ReactNode;
  required: boolean;
  linkHref: string;
  linkLabel: string;
  secondaryLinkHref?: string;
  secondaryLinkLabel?: string;
  entityLabel: string; // e.g., "contracts", "employees"
}

const STEPS: StepConfig[] = [
  {
    key: 'indirectCodes',
    title: 'Indirect Charge Codes',
    description: 'Set up leave, overhead, and G&A codes for DCAA-compliant total time accounting.',
    helpText: 'These codes let employees log non-billable time like PTO, holidays, overhead, and training. Click "Seed Default Codes" to create the 9 standard DCAA codes instantly.',
    icon: <IconReceipt size={18} />,
    required: false,
    linkHref: '/admin/indirect-codes',
    linkLabel: 'Go to Indirect Codes',
    entityLabel: 'indirect codes',
  },
  {
    key: 'contracts',
    title: 'Contracts',
    description: 'Create your contract structure.',
    helpText: 'Each contract needs a contract number and name. You can add details like funded value, ceiling value, and date range.',
    icon: <IconFileText size={18} />,
    required: true,
    linkHref: '/admin/contracts',
    linkLabel: 'Go to Contracts & CLINs',
    entityLabel: 'contracts',
  },
  {
    key: 'clins',
    title: 'CLINs (Contract Line Items)',
    description: 'Add line items under your contracts.',
    helpText: 'CLINs are the charge codes employees will log time against. Each contract needs at least one CLIN. Create them from within the Contracts & CLINs page.',
    icon: <IconList size={18} />,
    required: true,
    linkHref: '/admin/contracts',
    linkLabel: 'Go to Contracts & CLINs',
    entityLabel: 'CLINs',
  },
  {
    key: 'laborCategories',
    title: 'Labor Categories',
    description: 'Define billing rates per CLIN.',
    helpText: 'Labor categories (LCATs) define the roles and hourly rates for each CLIN. Examples: Senior Engineer at $145/hr, Help Desk Analyst at $55/hr.',
    icon: <IconCategory size={18} />,
    required: false,
    linkHref: '/admin/labor-categories',
    linkLabel: 'Go to Labor Categories',
    entityLabel: 'labor categories',
  },
  {
    key: 'employees',
    title: 'Employees',
    description: 'Add your team members.',
    helpText: 'Create user accounts for everyone who will log time. Each employee needs a name, email, and role (employee, supervisor, or admin).',
    icon: <IconUsers size={18} />,
    required: true,
    linkHref: '/admin/users',
    linkLabel: 'Go to User Management',
    secondaryLinkHref: '/admin/import',
    secondaryLinkLabel: 'Or use Data Import for bulk upload',
    entityLabel: 'employees',
  },
  {
    key: 'assignments',
    title: 'Assignments',
    description: 'Assign employees to the CLINs they can charge to.',
    helpText: 'DCAA requires that employees can ONLY charge time to CLINs they are explicitly assigned to. Each employee needs at least one CLIN assignment.',
    icon: <IconLink size={18} />,
    required: true,
    linkHref: '/admin/assignments',
    linkLabel: 'Go to User Assignments',
    entityLabel: 'assignments',
  },
];

export function SetupWizardClient({ initialStatus }: Props) {
  const [status, setStatus] = useState<SetupStatus>(initialStatus);
  const [isPending, startTransition] = useTransition();
  const [seedingIndirect, setSeedingIndirect] = useState(false);

  // Determine which step should be active (first incomplete required, or first incomplete recommended)
  function getActiveStep(): number {
    // First, find the first incomplete required step
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].required && status[STEPS[i].key] === 0) {
        return i;
      }
    }
    // All required done — find first incomplete recommended step
    for (let i = 0; i < STEPS.length; i++) {
      if (!STEPS[i].required && status[STEPS[i].key] === 0) {
        return i;
      }
    }
    // All done
    return STEPS.length;
  }

  const [activeStep, setActiveStep] = useState(getActiveStep);

  function refreshStatus() {
    startTransition(async () => {
      const updated = await getSetupStatus();
      setStatus(updated);
    });
  }

  async function handleSeedIndirect() {
    setSeedingIndirect(true);
    try {
      await seedIndirectCodes();
      notifications.show({
        title: 'Indirect codes created',
        message: '9 standard DCAA indirect charge codes have been seeded.',
        color: 'green',
      });
      refreshStatus();
    } catch (error) {
      notifications.show({
        title: 'Error',
        message: String(error),
        color: 'red',
      });
    } finally {
      setSeedingIndirect(false);
    }
  }

  function isStepComplete(step: StepConfig): boolean {
    return status[step.key] > 0;
  }

  // All done state
  if (status.isComplete) {
    const allSixDone = STEPS.every((s) => status[s.key] > 0);

    return (
      <Container size="md" py="xl">
        <Paper p="xl" radius="md" withBorder>
          <Stack align="center" gap="lg">
            <ThemeIcon size={80} radius="xl" color="green" variant="light">
              <IconConfetti size={40} />
            </ThemeIcon>
            <Title order={2}>Setup Complete!</Title>
            <Text c="dimmed" ta="center" maw={500}>
              {allSixDone
                ? 'All 6 setup steps are complete. Your ByTime instance is fully configured and ready for your team to start logging time.'
                : 'All required setup steps are complete. Your team can start logging time. You can still complete the recommended steps below for full DCAA compliance.'}
            </Text>

            {!allSixDone && (
              <Alert color="yellow" variant="light" title="Recommended steps remaining" maw={500}>
                {STEPS.filter((s) => !s.required && status[s.key] === 0).map((s) => (
                  <Text key={s.key} size="sm">
                    • {s.title} — <Anchor href={s.linkHref} size="sm">{s.linkLabel}</Anchor>
                  </Text>
                ))}
              </Alert>
            )}

            <Group>
              <Button component="a" href="/timesheet" variant="filled">
                Go to Timesheet
              </Button>
              <Button component="a" href="/admin/dashboard" variant="light">
                Admin Dashboard
              </Button>
            </Group>
          </Stack>
        </Paper>

        {/* Summary stats */}
        <Paper p="md" radius="md" withBorder mt="lg">
          <Title order={4} mb="sm">Setup Summary</Title>
          <Group grow>
            {STEPS.map((step) => (
              <Paper key={step.key} p="sm" radius="sm" withBorder>
                <Group gap="xs">
                  {isStepComplete(step) ? (
                    <ThemeIcon size="sm" color="green" variant="light" radius="xl">
                      <IconCheck size={12} />
                    </ThemeIcon>
                  ) : (
                    <Badge size="xs" color="yellow" variant="light">Pending</Badge>
                  )}
                  <Text size="sm" fw={500}>{step.title}</Text>
                </Group>
                <Text size="xs" c="dimmed" mt={4}>
                  {status[step.key]} {step.entityLabel}
                </Text>
              </Paper>
            ))}
          </Group>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="md" py="xl">
      <Group justify="space-between" align="flex-start" mb="xl">
        <div>
          <Group gap="sm" mb={4}>
            <ThemeIcon size="lg" color="blue" variant="light" radius="md">
              <IconRocket size={20} />
            </ThemeIcon>
            <Title order={2}>Setup Wizard</Title>
          </Group>
          <Text c="dimmed" size="sm">
            Complete these steps to get your ByTime instance ready for your team.
          </Text>
        </div>
        <Button
          variant="subtle"
          size="sm"
          leftSection={<IconRefresh size={14} />}
          onClick={refreshStatus}
          loading={isPending}
        >
          Refresh Status
        </Button>
      </Group>

      <Stepper
        active={activeStep}
        onStepClick={setActiveStep}
        orientation="vertical"
        size="sm"
        classNames={{ stepIcon: classes.stepIcon }}
      >
        {STEPS.map((step, index) => (
          <Stepper.Step
            key={step.key}
            label={step.title}
            description={isStepComplete(step)
              ? `${status[step.key]} ${step.entityLabel} created`
              : step.description
            }
            icon={step.icon}
            completedIcon={<IconCheck size={16} />}
            color={isStepComplete(step) ? 'green' : undefined}
            loading={isPending && activeStep === index}
          >
            <Paper p="md" radius="md" withBorder ml="sm" mb="md">
              <Group justify="space-between" mb="sm">
                <Text fw={600}>{step.title}</Text>
                <Badge
                  color={isStepComplete(step) ? 'green' : step.required ? 'red' : 'yellow'}
                  variant="light"
                  size="sm"
                >
                  {isStepComplete(step) ? 'Done' : step.required ? 'Required' : 'Recommended'}
                </Badge>
              </Group>

              <Text size="sm" c="dimmed" mb="md">
                {step.helpText}
              </Text>

              {isStepComplete(step) ? (
                <Alert color="green" variant="light" mb="sm">
                  <Text size="sm">
                    ✅ {status[step.key]} {step.entityLabel} created
                  </Text>
                </Alert>
              ) : (
                <Alert color={step.required ? 'red' : 'yellow'} variant="light" mb="sm">
                  <Text size="sm">
                    No {step.entityLabel} created yet
                  </Text>
                </Alert>
              )}

              <Group gap="sm">
                {/* Special: Seed Default Codes button for indirect codes step */}
                {step.key === 'indirectCodes' && status.indirectCodes === 0 && (
                  <Button
                    variant="filled"
                    size="sm"
                    onClick={handleSeedIndirect}
                    loading={seedingIndirect}
                  >
                    Seed Default DCAA Codes
                  </Button>
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
        ))}
      </Stepper>
    </Container>
  );
}
