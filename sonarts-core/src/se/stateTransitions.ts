/*
 * SonarTS
 * Copyright (C) 2017-2019 SonarSource SA
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */
import * as ts from "typescript";
import {
  numericLiteralSymbolicValue,
  simpleSymbolicValue,
  undefinedSymbolicValue,
  objectLiteralSymbolicValue,
  booleanLiteralSymbolicValue,
  executableSymbolicValue,
} from "./symbolicValues";
import { ProgramState } from "./programStates";
import { SymbolTable } from "../symbols/table";
import { collectLeftHandIdentifiers } from "../utils/navigation";
import { truthyConstraint, falsyConstraint, isFalsy, isTruthy, executedConstraint, isExecuted } from "./constraints";
import * as nodes from "../utils/nodes";

export interface InterProcedural {
  parameters: boolean[],
  closure: ts.Symbol[],
}

export namespace InterProcedural {
  export const Default = {
    parameters: [],
    closure: [],
  };
}

export function applyExecutors(
  programPoint: ts.Node,
  state: ProgramState,
  symbols: SymbolTable,
  shouldTrackSymbol: (symbol: ts.Symbol) => boolean = () => true,
  onCallNode: (node: ts.CallExpression) => InterProcedural,
): ProgramState {
  const { parent } = programPoint;

  // TODO is there a better way to handle this?
  // special case: `let x;`
  if (parent && nodes.isVariableDeclaration(parent) && parent.name === programPoint) {
    return variableDeclaration(parent);
  }

  if (nodes.isNumericLiteral(programPoint)) {
    return numeralLiteral(programPoint);
  }

  if (nodes.isIdentifier(programPoint)) {
    return identifier(programPoint);
  }

  if (nodes.isBinaryExpression(programPoint)) {
    return binaryExpression(programPoint);
  }

  if (nodes.isVariableDeclaration(programPoint)) {
    return variableDeclaration(programPoint);
  }

  if (nodes.isCallExpression(programPoint)) {
    return callExpression(programPoint);
  }

  if (nodes.isObjectLiteralExpression(programPoint)) {
    return objectLiteralExpression();
  }

  if (nodes.isBooleanLiteral(programPoint)) {
    return booleanLiteral(programPoint);
  }

  if (nodes.isPropertyAccessExpression(programPoint)) {
    return propertyAccessExpression(programPoint);
  }

  if (nodes.isPostfixUnaryExpression(programPoint)) {
    return postfixUnaryExpression(programPoint);
  }

  if (nodes.isPrefixUnaryExpression(programPoint)) {
    return prefixUnaryExpression(programPoint);
  }

  if (nodes.isFunctionLikeDeclaration(programPoint)) {
    return functionLikeDeclaration(programPoint);
  }

  return state.pushSV(simpleSymbolicValue());

  function identifier(identifier: ts.Identifier) {
    const symbol = symbolAt(identifier);
    let sv = symbol && state.sv(symbol);
    let nextState = state;
    if (!sv) {
      sv = simpleSymbolicValue();
      if (symbol) {
        nextState = state.setSV(symbol, sv);
      }
    }
    return nextState.pushSV(sv);
  }

  function numeralLiteral(literal: ts.NumericLiteral) {
    const c = Number(literal.text) ? truthyConstraint() : falsyConstraint();
    return state.pushSV(numericLiteralSymbolicValue(literal.text))
      .constrain(c)!;
  }

  function booleanLiteral(literal: ts.BooleanLiteral) {
    const c = literal.kind === ts.SyntaxKind.FalseKeyword ? falsyConstraint() : truthyConstraint();
    return state.pushSV(booleanLiteralSymbolicValue())
      .constrain(c)!;
  }

  function binaryExpression(expression: ts.BinaryExpression) {
    return nodes.isAssignmentKind(expression.operatorToken.kind)
      ? assignmentLike(expression)
      : state.pushSV(simpleSymbolicValue());
  }

  function assignmentLike(expression: ts.BinaryExpression) {
    return expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? assignment(expression)
      : compoundAssignment(expression);
  }

  function assignment(expression: ts.BinaryExpression) {
    return collectLeftHandIdentifiers(expression.left).identifiers.reduce((state, identifier) => {
      let [value, nextState] = state.popSV();
      const variable = symbolAt(identifier);
      if (!variable) {
        return nextState;
      }

      if (!value) {
        throw new Error("Assignment without value");
      }
      return nextState.pushSV(value).setSV(variable, value);
    }, state);
  }

  function compoundAssignment(expression: ts.BinaryExpression) {
    return collectLeftHandIdentifiers(expression.left).identifiers.reduce((state, identifier) => {
      const variable = symbolAt(identifier);
      const value = simpleSymbolicValue();
      return variable ? state.pushSV(value).setSV(variable, value) : state;
    }, state);
  }

  function functionLikeDeclaration(declaration: ts.FunctionLikeDeclaration) {
    const esv = executableSymbolicValue();
    // May create a variable binding
    if (nodes.isIdentifier(declaration.name as ts.Node)) {
      const name = declaration.name as ts.Identifier;
      const variable = symbolAt(name);
      if (!variable || !shouldTrackSymbol(variable)) {
        return state;
      }

      return state.setSV(variable, esv);
    }
    // Could be used as an expression
    return state.pushSV(esv);
  }

  function variableDeclaration(declaration: ts.VariableDeclaration) {
    if (nodes.isIdentifier(declaration.name)) {
      let [value, nextState] = state.popSV();
      const variable = symbolAt(declaration.name);
      if (!variable || !shouldTrackSymbol(variable)) {
        return nextState;
      }

      if (!value) {
        value = undefinedSymbolicValue();
      }
      return nextState.setSV(variable, value);
    }
    return state;
  }

  function callExpression(callExpression: ts.CallExpression) {
    const { parameters: mustCall, closure } = onCallNode(callExpression);
    let nextState = state;
    let sv;
    callExpression.arguments.forEach((_, i) => {
      if (mustCall[i]) {
        nextState = nextState.constrain(executedConstraint())!;
      }
      [sv, nextState] = nextState.popSV();
    });
    // Now for closure symbols
    for (const symbol of closure) {
      nextState = nextState.constrainSymbol(symbol, executedConstraint())!;
    }
    nextState = nextState.constrain(executedConstraint())!; // Constrain callee
    [sv, nextState] = nextState.popSV(); // Pop callee value
    nextState = nextState.pushSV(simpleSymbolicValue());

    return nextState;
  }

  function objectLiteralExpression() {
    // TODO it's not so simple. We need to pop plenty of things here
    return state.pushSV(objectLiteralSymbolicValue());
  }

  function propertyAccessExpression(pAccess: ts.PropertyAccessExpression) {
    state = state.popSV()[1].pushSV(simpleSymbolicValue())
    return identifier(pAccess.name);
  }

  function prefixUnaryExpression(unary: ts.PrefixUnaryExpression) {
    if (unary.operator !== ts.SyntaxKind.ExclamationToken) {
      return state;
    }
    let [sv, nextState] = state.popSV();
    const nsv = booleanLiteralSymbolicValue();
    nextState = nextState.pushSV(nsv);
    if (isFalsy(state.getConstraints(sv!))) {
      nextState = nextState.constrain(truthyConstraint())!;
    } else if (isTruthy(state.getConstraints(sv!))) {
      nextState = nextState.constrain(falsyConstraint())!;
    }
    return nextState;
  }

  function postfixUnaryExpression(unary: ts.PostfixUnaryExpression) {
    let nextState = state;
    const operand = unary.operand;
    const sv = simpleSymbolicValue();
    if (nodes.isIdentifier(operand)) {
      const symbol = symbolAt(operand);
      if (symbol) {
        nextState = nextState.setSV(symbol, sv);
      }
    }
    return nextState.popSV()[1].pushSV(sv);
  }

  function symbolAt(node: ts.Node) {
    return (symbols.getUsage(node) || { symbol: null }).symbol;
  }
}
